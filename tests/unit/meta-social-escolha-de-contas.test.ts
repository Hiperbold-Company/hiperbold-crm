/**
 * A ESCOLHA das contas da Meta (D-242), de ponta a ponta: o callback com 2+
 * contas não conecta nada e grava o cookie selado; a listagem redescobre sem
 * devolver token; a confirmação conecta SÓ as marcadas, queima o nonce e
 * recusa escolha de outra empresa, de outra pessoa ou já usada.
 *
 * Contra o banco em memória (nonce único real, `channel_sessions` real) e a
 * Meta dublada por `fetch`. A sessão (papel, organização ativa, MFA, cerca do
 * suporte) é dublada: é a fronteira que estas rotas leem, não o código testado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

const SEGREDO = "segredo-interno-com-mais-de-16-caracteres";
process.env.INTERNAL_SECRET = SEGREDO;
process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo";
process.env.META_APP_ID = "12345678";
process.env.META_APP_SECRET = "segredo-do-app-da-meta";
process.env.META_UNIFIED_CONFIG_ID = "1855366338969369";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OUTRO_USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const h = vi.hoisted(() => ({
  db: null as unknown,
  audit: vi.fn(async (_e: Record<string, unknown>) => undefined),
  podeCriar: vi.fn(async () => ({ pode: true })),
  sessao: { orgId: "", userId: "" },
  suporte: null as Response | null,
  mfa: false,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/impersonate/support", () => ({
  supportCallbackWriteAllowed: async () => true,
  requireSupportWrite: async () => h.suporte,
  authenticatedSessionId: async () => "sessao-atual",
}));
vi.mock("@/lib/billing/planos/pode-criar", () => ({ podeCriar: h.podeCriar }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: h.sessao.userId }, org: { orgId: h.sessao.orgId } }),
}));
vi.mock("@/lib/auth/server", async (original) => ({
  ...((await original()) as object),
  mfaEmDivida: async () => h.mfa,
}));

import { NextRequest as Requisicao } from "next/server";
import { invalidarAppDaMeta } from "@/lib/channels/meta/app";
import { invalidarConfigMetaSocial } from "@/lib/channels/meta-social/config";
import {
  NOME_DO_VINCULO_META_SOCIAL,
  assinarVinculoMetaSocial,
  emitirEstadoMetaSocial,
} from "@/lib/channels/meta-social/estado";
import { NOME_DA_SELECAO_META_SOCIAL } from "@/lib/channels/meta-social/selecao";

const IG_1 = "17841400000000001";
const IG_2 = "17841400000000002";
const IG_3 = "17841400000000003";

type Chamada = { url: string; init?: RequestInit };

/** A Meta: login unificado (SUAT, contas do portfólio) e Messenger (Páginas com token). */
function metaFalsa(opcoes: { contasIg?: { id: string; username: string }[]; paginas?: Record<string, unknown>[] }) {
  const chamadas: Chamada[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    chamadas.push({ url: u, init });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.endsWith("/oauth/access_token")) {
      const corpo = new URLSearchParams(String(init?.body ?? ""));
      if (corpo.get("grant_type") === "fb_exchange_token") return json({ access_token: "LONGO" });
      return json({ access_token: opcoes.paginas ? "CURTO" : "SUAT" });
    }
    if (u.includes("/me?fields=client_business_id,id")) return json({ client_business_id: "BIZ-1", id: "SU-1" });
    if (u.endsWith("/me?fields=id")) return json({ id: "FB-PESSOA" });
    if (u.includes("/me/assigned_instagram_accounts")) return json({ data: opcoes.contasIg ?? [], paging: {} });
    if (u.includes("/me/accounts")) return json({ data: opcoes.paginas ?? [], paging: {} });
    if (u.includes("/subscribed_apps")) return json({ success: true });
    if (u.includes("/debug_token")) return json({ data: { scopes: [], granular_scopes: [] } });
    return new Response("{}", { status: 404 });
  });
  return { fetcher, chamadas };
}

const novoBanco = () =>
  bancoFalso({ user_organizations: [{ organization_id: ORG, user_id: USER, role: "admin", revoked_at: null }] });

/** A volta do OAuth; devolve a resposta inteira (para ler o cookie). */
async function callback(plataforma: "instagram" | "messenger", nonce: string): Promise<Response> {
  const state = emitirEstadoMetaSocial(
    { plataforma, organizationId: ORG, userId: USER },
    { segredo: SEGREDO, agora: new Date(), nonce },
  );
  const { GET } = await import("@/app/api/v1/channels/meta-social/callback/[plataforma]/route");
  const req = new Requisicao(
    `https://crm.exemplo/api/v1/channels/meta-social/callback/${plataforma}?code=abc&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `${NOME_DO_VINCULO_META_SOCIAL}=${assinarVinculoMetaSocial(nonce, SEGREDO)}` } },
  );
  return GET(req, { params: Promise.resolve({ plataforma }) });
}

const destinoDe = async (res: Response) =>
  new URL(decodeURIComponent(/location\.replace\("([^"]+)"\)/.exec(await res.clone().text())?.[1] ?? ""));

function cookieDaEscolha(res: Response): string {
  const linha = res.headers.getSetCookie().find((c) => c.startsWith(`${NOME_DA_SELECAO_META_SOCIAL}=`));
  if (!linha) throw new Error("callback não gravou a escolha");
  return linha.slice(NOME_DA_SELECAO_META_SOCIAL.length + 1).split(";")[0]!;
}

async function rota() {
  return import("@/app/api/v1/channels/meta-social/selecao/route");
}

function pedido(plataforma: string, cookie: string | null, metodo = "GET", corpo?: unknown): NextRequest {
  return new Requisicao(`https://crm.exemplo/api/v1/channels/meta-social/selecao?plataforma=${plataforma}`, {
    method: metodo,
    headers: {
      ...(cookie ? { cookie: `${NOME_DA_SELECAO_META_SOCIAL}=${cookie}` } : {}),
      ...(corpo !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
}

const listar = async (plataforma: string, cookie: string | null) => (await rota()).GET(pedido(plataforma, cookie));
const confirmar = async (plataforma: string, cookie: string | null, corpo: unknown) =>
  (await rota()).POST(pedido(plataforma, cookie, "POST", corpo));

const apagouOCookie = (res: Response) =>
  res.headers.getSetCookie().some((c) => c.startsWith(`${NOME_DA_SELECAO_META_SOCIAL}=;`) && /Max-Age=0/i.test(c));

/** Toda chave e todo valor de texto do JSON, em qualquer profundidade. */
function folhas(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) folhas(x, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      folhas(x, out);
    }
  else if (typeof v === "string") out.push(v);
  return out;
}

let banco: ReturnType<typeof novoBanco>;
let meta: ReturnType<typeof metaFalsa>;
beforeEach(() => {
  invalidarAppDaMeta();
  invalidarConfigMetaSocial();
  h.audit.mockClear();
  h.podeCriar.mockReset();
  h.podeCriar.mockResolvedValue({ pode: true });
  h.sessao = { orgId: ORG, userId: USER };
  h.suporte = null;
  h.mfa = false;
  banco = novoBanco();
  h.db = banco.db;
  meta = metaFalsa({
    contasIg: [
      { id: IG_1, username: "loja" },
      { id: IG_2, username: "loja2" },
      { id: IG_3, username: "cliente_de_outro" },
    ],
  });
  vi.stubGlobal("fetch", meta.fetcher);
});

describe("callback com várias contas", () => {
  it("não conecta nenhuma, grava a escolha num cookie httpOnly restrito ao endpoint, e manda escolher", async () => {
    const res = await callback("instagram", "e-1");
    const destino = await destinoDe(res);
    expect(destino.searchParams.get("meta_social")).toBe("escolher");
    expect(destino.searchParams.get("plataforma")).toBe("instagram");
    expect(banco.t("channel_sessions")).toHaveLength(0);
    expect(meta.chamadas.some((c) => c.url.includes("/subscribed_apps"))).toBe(false);

    const linha = res.headers.getSetCookie().find((c) => c.startsWith(`${NOME_DA_SELECAO_META_SOCIAL}=`))!;
    expect(linha).toMatch(/Path=\/api\/v1\/channels\/meta-social\/selecao/);
    expect(linha).toMatch(/HttpOnly/i);
    expect(linha).toMatch(/SameSite=Lax/i);
    expect(linha).toMatch(/Max-Age=600/);
    expect(linha).toMatch(/Secure/i);
    expect(linha).not.toContain("SUAT");
  });
});

describe("GET da escolha", () => {
  it("lista as contas redescobertas sem token nenhum, com onde cada uma já está", async () => {
    banco.t("channel_sessions").push(
      { id: "aqui", organization_id: ORG, provider: "meta_social", meta_social_platform: "instagram", meta_social_account_id: IG_2, archived_at: null },
      { id: "la", organization_id: OUTRA_ORG, provider: "meta_social", meta_social_platform: "instagram", meta_social_account_id: IG_3, archived_at: null },
    );
    const cookie = cookieDaEscolha(await callback("instagram", "e-2"));
    const res = await listar("instagram", cookie);
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { plataforma: string; expira_em: string; contas: Record<string, unknown>[] } };
    expect(corpo.data.plataforma).toBe("instagram");
    expect(Date.parse(corpo.data.expira_em)).toBeGreaterThan(Date.now());
    expect(corpo.data.contas).toEqual([
      { id: IG_1, nome: null, usuario: "loja", ja_conectada_aqui: false, em_outra_empresa: false },
      { id: IG_2, nome: null, usuario: "loja2", ja_conectada_aqui: true, em_outra_empresa: false },
      { id: IG_3, nome: null, usuario: "cliente_de_outro", ja_conectada_aqui: false, em_outra_empresa: true },
    ]);
    const tudo = folhas(corpo);
    expect(tudo.some((f) => /token/i.test(f))).toBe(false);
    expect(tudo.some((f) => /SUAT|LONGO/.test(f))).toBe(false);
    expect(tudo).not.toContain(OUTRA_ORG);
    // Listar não conecta nem assina nada.
    expect(meta.chamadas.some((c) => c.url.includes("/subscribed_apps"))).toBe(false);
    expect(banco.t("channel_sessions")).toHaveLength(2);
  });

  it("no Messenger, nenhum token de Página sai na listagem", async () => {
    meta = metaFalsa({
      paginas: [
        { id: "101", name: "Loja", access_token: "TOKEN-PAG-1" },
        { id: "102", name: "Outlet", access_token: "TOKEN-PAG-2" },
      ],
    });
    vi.stubGlobal("fetch", meta.fetcher);
    const cookie = cookieDaEscolha(await callback("messenger", "e-3"));
    const corpo = await (await listar("messenger", cookie)).json();
    expect(folhas(corpo).some((f) => /token/i.test(f))).toBe(false);
    expect((corpo as { data: { contas: { id: string }[] } }).data.contas.map((c) => c.id)).toEqual(["101", "102"]);
  });

  it("escolha aberta em OUTRA empresa (troca de empresa no mesmo navegador) é recusada", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-4"));
    h.sessao = { orgId: OUTRA_ORG, userId: USER };
    const res = await listar("instagram", cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("selecao_de_outra_empresa");
  });

  it("escolha de OUTRA pessoa é recusada", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-5"));
    h.sessao = { orgId: ORG, userId: OUTRO_USER };
    expect((await listar("instagram", cookie)).status).toBe(403);
  });

  it("sem cookie, ou no caminho da outra plataforma: expirada, refaça", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-6"));
    const sem = await listar("instagram", null);
    expect(sem.status).toBe(410);
    expect(((await sem.json()) as { error: { code: string } }).error.code).toBe("selecao_expirada");
    expect((await listar("messenger", cookie)).status).toBe(410);
    expect((await listar("whatsapp", cookie)).status).toBe(400);
  });
});

describe("POST da escolha", () => {
  it("conecta SÓ as marcadas, ignora id fora do conjunto, queima o nonce e apaga o cookie", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-7"));
    const res = await confirmar("instagram", cookie, { ids: [IG_1, "99999999999"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ conectadas: 1, recusadas: 0 });
    expect(apagouOCookie(res)).toBe(true);

    const sessoes = banco.t("channel_sessions");
    expect(sessoes.map((s) => s.meta_social_account_id)).toEqual([IG_1]);
    expect(sessoes[0]).toMatchObject({
      organization_id: ORG,
      provider: "meta_social",
      meta_social_platform: "instagram",
      meta_social_token_encrypted: "cifrado:SUAT",
      status: "WORKING",
    });
    expect(sessoes[0]!.metadata).toMatchObject({ meta_autorizador_id: "SU-1", meta_client_business_id: "BIZ-1" });

    // Só a marcada foi assinada na Meta, com o SUAT.
    const assinaturas = meta.chamadas.filter((c) => c.url.includes("/subscribed_apps"));
    expect(assinaturas.map((c) => c.url)).toEqual([`https://graph.facebook.com/v26.0/${IG_1}/subscribed_apps`]);
    expect((assinaturas[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer SUAT");
    expect(banco.t("calendar_oauth_nonces")).toHaveLength(2); // o do state e o da escolha
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.connected", organizationId: ORG, actorUserId: USER }),
    );
  });

  it("replay: a mesma escolha não conecta de novo", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-8"));
    expect((await confirmar("instagram", cookie, { ids: [IG_1] })).status).toBe(200);
    const replay = await confirmar("instagram", cookie, { ids: [IG_2] });
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("selecao_ja_usada");
    expect(banco.t("channel_sessions").map((s) => s.meta_social_account_id)).toEqual([IG_1]);
  });

  it("escolha de OUTRA empresa ou de outra pessoa: recusada, sem queimar o nonce e sem conectar", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-9"));
    h.sessao = { orgId: OUTRA_ORG, userId: USER };
    expect((await confirmar("instagram", cookie, { ids: [IG_1] })).status).toBe(403);
    h.sessao = { orgId: ORG, userId: OUTRO_USER };
    expect((await confirmar("instagram", cookie, { ids: [IG_1] })).status).toBe(403);
    expect(banco.t("channel_sessions")).toHaveLength(0);
    expect(banco.t("calendar_oauth_nonces")).toHaveLength(1); // só o do state
    // De volta à empresa e à pessoa certas, a escolha ainda vale.
    h.sessao = { orgId: ORG, userId: USER };
    expect((await confirmar("instagram", cookie, { ids: [IG_1] })).status).toBe(200);
  });

  it("corpo inválido não gasta a escolha", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-10"));
    for (const corpo of [{ ids: [] }, { ids: ["IG-1"] }, { ids: Array.from({ length: 21 }, (_, i) => String(i + 1)) }, {}]) {
      expect((await confirmar("instagram", cookie, corpo)).status).toBe(400);
    }
    expect(banco.t("calendar_oauth_nonces")).toHaveLength(1);
    expect((await confirmar("instagram", cookie, { ids: [IG_2] })).status).toBe(200);
  });

  it("só ids que a redescoberta não traz: 422, nada conectado, a escolha continua de pé", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-11"));
    const res = await confirmar("instagram", cookie, { ids: ["99999999999"] });
    expect(res.status).toBe(422);
    expect(banco.t("channel_sessions")).toHaveLength(0);
    expect(meta.chamadas.some((c) => c.url.includes("/subscribed_apps"))).toBe(false);
    expect((await confirmar("instagram", cookie, { ids: [IG_1] })).status).toBe(200);
  });

  it("acompanhamento só leitura: a cerca do suporte responde antes de qualquer efeito", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-12"));
    h.suporte = new Response(JSON.stringify({ error: { code: "support_readonly" } }), { status: 403 });
    const res = await confirmar("instagram", cookie, { ids: [IG_1] });
    expect(res.status).toBe(403);
    expect(banco.t("channel_sessions")).toHaveLength(0);
    expect(banco.t("calendar_oauth_nonces")).toHaveLength(1);
  });

  it("MFA em dívida: recusa sem conectar", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-13"));
    h.mfa = true;
    const res = await confirmar("instagram", cookie, { ids: [IG_1] });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    expect(banco.t("channel_sessions")).toHaveLength(0);
  });

  it("limite do plano numa das marcadas: parcial, com o motivo, e a trilha da recusa", async () => {
    h.podeCriar.mockReset();
    h.podeCriar.mockResolvedValueOnce({ pode: true }).mockResolvedValue({ pode: false });
    const cookie = cookieDaEscolha(await callback("instagram", "e-14"));
    const res = await confirmar("instagram", cookie, { ids: [IG_1, IG_2] });
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      conectadas: 1,
      recusadas: 1,
      motivo: "limite_do_plano",
    });
    expect(banco.t("channel_sessions")).toHaveLength(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.meta_social_connect_failed",
        organizationId: ORG,
        metadata: expect.objectContaining({ motivo: "limite_do_plano", detalhe: "escolha:1/2" }),
      }),
    );
  });

  it("Messenger: cada Página marcada com o token dela; a viva em outra empresa é recusada", async () => {
    banco.t("channel_sessions").push({
      id: "la",
      organization_id: OUTRA_ORG,
      provider: "meta_social",
      meta_social_platform: "messenger",
      meta_social_account_id: "102",
      archived_at: null,
    });
    meta = metaFalsa({
      paginas: [
        { id: "101", name: "Loja", access_token: "TOKEN-PAG-1" },
        { id: "102", name: "Outlet", access_token: "TOKEN-PAG-2" },
        { id: "103", name: "Cliente de outro", access_token: "TOKEN-PAG-3" },
      ],
    });
    vi.stubGlobal("fetch", meta.fetcher);
    const cookie = cookieDaEscolha(await callback("messenger", "e-15"));
    const res = await confirmar("messenger", cookie, { ids: ["101", "102"] });
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      conectadas: 1,
      recusadas: 1,
      motivo: "conta_em_outra_organizacao",
    });
    const daqui = banco.t("channel_sessions").filter((s) => s.organization_id === ORG);
    expect(daqui.map((s) => s.meta_social_account_id)).toEqual(["101"]);
    expect(daqui[0]).toMatchObject({ meta_social_token_encrypted: "cifrado:TOKEN-PAG-1" });
    expect((daqui[0]!.metadata as Record<string, unknown>).meta_autorizador_id).toBe("FB-PESSOA");
    // A Página não marcada (103) nem a de outra empresa (102) foram assinadas.
    expect(meta.chamadas.filter((c) => c.url.includes("/subscribed_apps")).map((c) => new URL(c.url).pathname)).toEqual([
      "/v26.0/101/subscribed_apps",
    ]);
  });
});

describe("DELETE da escolha", () => {
  it("cancelar apaga o cookie sem chamar a Meta nem conectar", async () => {
    const cookie = cookieDaEscolha(await callback("instagram", "e-16"));
    const antes = meta.chamadas.length;
    const res = await (await rota()).DELETE();
    expect(res.status).toBe(200);
    expect(apagouOCookie(res)).toBe(true);
    expect(meta.chamadas).toHaveLength(antes);
    expect(banco.t("channel_sessions")).toHaveLength(0);
    expect(cookie).toBeTruthy();
  });
});
