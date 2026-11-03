/**
 * Volta do OAuth do Instagram pelo LOGIN UNIFICADO: state + vínculo + nonce de
 * uso único, troca do código pelo token de usuário do sistema (SUAT) com o app
 * da Meta, contas concedidas (paginadas), assinatura do webhook e as recusas.
 * Contra o banco em memória (nonce único real) e a Meta dublada por `fetch`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

const SEGREDO = "segredo-interno-com-mais-de-16-caracteres";
process.env.INTERNAL_SECRET = SEGREDO;
process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo";
process.env.META_APP_ID = "12345678";
process.env.META_APP_SECRET = "segredo-do-app-da-meta";
process.env.META_UNIFIED_CONFIG_ID = "1855366338969369";

const h = vi.hoisted(() => ({
  db: null as unknown,
  audit: vi.fn(async () => undefined),
  podeCriar: vi.fn(async () => ({ pode: true })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/impersonate/support", () => ({ supportCallbackWriteAllowed: async () => true }));
vi.mock("@/lib/billing/planos/pode-criar", () => ({ podeCriar: h.podeCriar }));

import { invalidarAppDaMeta } from "@/lib/channels/meta/app";
import { invalidarConfigMetaSocial, resolverConfigMetaSocial } from "@/lib/channels/meta-social/config";
import {
  NOME_DO_VINCULO_META_SOCIAL,
  assinarVinculoMetaSocial,
  emitirEstadoMetaSocial,
} from "@/lib/channels/meta-social/estado";
import { urlDeConsentimento } from "@/lib/channels/meta-social/oauth";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Chamada = { url: string; init?: RequestInit };

/**
 * A Meta do login unificado. `paginas` = as páginas de `assigned_instagram_accounts`;
 * `paginasDoFacebook` = o `/me/accounts` (undefined = a chamada falha, como sem permissão).
 */
function metaFalsa(
  paginas: { id: string; username: string }[][],
  granulares: string[] = [],
  paginasDoFacebook?: Record<string, unknown>[],
  /** Token de USUÁRIO (2ª configuração): `/me?fields=client_business_id` e `assigned_instagram_accounts` recusam. */
  tokenDeUsuario = false,
) {
  const chamadas: Chamada[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    chamadas.push({ url: u, init });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.endsWith("/oauth/access_token")) {
      const corpo = new URLSearchParams(String(init?.body ?? ""));
      if (corpo.get("client_id") !== "12345678" || corpo.get("client_secret") !== "segredo-do-app-da-meta")
        return new Response(JSON.stringify({ error: { code: 101, message: "app errado" } }), { status: 400 });
      if (corpo.get("grant_type") === "fb_exchange_token") return json({ access_token: "LONGO", token_type: "bearer" });
      return json({ access_token: "SUAT", token_type: "bearer" });
    }
    const recusa = () => new Response(JSON.stringify({ error: { code: 100, message: "nonexisting field" } }), { status: 400 });
    if (tokenDeUsuario && (u.includes("/me?fields=client_business_id") || u.includes("/me/assigned_instagram_accounts")))
      return recusa();
    if (u.includes("/me?fields=client_business_id,id")) return json({ client_business_id: "BIZ-1", id: "SU-1" });
    if (u.endsWith("/me?fields=id")) return json({ id: "FB-1" });
    if (u.includes("/me/accounts") && paginasDoFacebook) return json({ data: paginasDoFacebook, paging: {} });
    if (u.includes("/me/assigned_instagram_accounts")) {
      const depois = new URL(u).searchParams.get("after");
      const i = depois ? Number(depois) : 0;
      const ultima = i >= paginas.length - 1;
      return json({
        data: paginas[i] ?? [],
        paging: ultima ? {} : { cursors: { after: String(i + 1) }, next: "https://graph.facebook.com/proxima" },
      });
    }
    if (u.includes("/subscribed_apps")) return json({ success: true });
    if (u.includes("/debug_token")) {
      return json({
        data: {
          scopes: ["instagram_basic", "instagram_manage_messages"],
          granular_scopes: granulares.length ? [{ scope: "instagram_basic", target_ids: granulares }] : [],
        },
      });
    }
    const porId = granulares.find((id) => u.includes(`/${id}?fields=`));
    if (porId) return json({ id: porId, username: `conta_${porId}` });
    return new Response("{}", { status: 404 });
  });
  return { fetcher, chamadas };
}

async function chamar(nonce: string, cookie: string | null = assinarVinculoMetaSocial(nonce, SEGREDO)) {
  const state = emitirEstadoMetaSocial(
    { plataforma: "instagram", organizationId: ORG, userId: USER },
    { segredo: SEGREDO, agora: new Date(), nonce },
  );
  return chamarComState(state, cookie);
}

async function chamarComState(state: string, cookie: string | null) {
  const { GET } = await import("@/app/api/v1/channels/meta-social/callback/[plataforma]/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `https://crm.exemplo/api/v1/channels/meta-social/callback/instagram?code=abc&state=${encodeURIComponent(state)}`,
    { headers: cookie ? { cookie: `${NOME_DO_VINCULO_META_SOCIAL}=${cookie}` } : {} },
  );
  const res = await GET(req, { params: Promise.resolve({ plataforma: "instagram" }) });
  const html = await res.text();
  return decodeURIComponent(/location\.replace\("([^"]+)"\)/.exec(html)?.[1] ?? "");
}

const novoBanco = () =>
  bancoFalso({ user_organizations: [{ organization_id: ORG, user_id: USER, role: "admin", revoked_at: null }] });

let meta: ReturnType<typeof metaFalsa>;
beforeEach(() => {
  invalidarAppDaMeta();
  invalidarConfigMetaSocial();
  h.audit.mockClear();
  h.podeCriar.mockReset();
  h.podeCriar.mockResolvedValue({ pode: true });
  meta = metaFalsa([[{ id: "IG-1", username: "loja" }], [{ id: "IG-2", username: "loja2" }]]);
  vi.stubGlobal("fetch", meta.fetcher);
});

describe("login unificado: URL e configuração", () => {
  it("diálogo do facebook.com com config_id e override_default_response_type, sem scope", () => {
    const u = new URL(
      urlDeConsentimento(
        "instagram",
        { appId: "12345678", appSecret: "x", configId: "1855366338969369" },
        "https://crm.hiperbold.com.br/api/v1/channels/meta-social/callback/instagram",
        "STATE",
      ),
    );
    expect(`${u.origin}${u.pathname}`).toBe("https://www.facebook.com/dialog/oauth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "12345678",
      config_id: "1855366338969369",
      redirect_uri: "https://crm.hiperbold.com.br/api/v1/channels/meta-social/callback/instagram",
      response_type: "code",
      override_default_response_type: "true",
      state: "STATE",
    });
  });

  it("Instagram só fica configurado com app da Meta + chave + config_id; banco vence o .env", () => {
    const meta = { appSecret: "s", verifyToken: null };
    expect(resolverConfigMetaSocial({ app_id: "1", unified_config_id: null }, meta, {}).instagram).toBeNull();
    expect(resolverConfigMetaSocial({ app_id: "1", unified_config_id: "9" }, { ...meta, appSecret: null }, {}).instagram).toBeNull();
    expect(
      resolverConfigMetaSocial({ app_id: "1", unified_config_id: "9" }, meta, { META_UNIFIED_CONFIG_ID: "8" }).instagram,
    ).toEqual({ appId: "1", appSecret: "s", configId: "9" });
    expect(resolverConfigMetaSocial(null, meta, { META_APP_ID: "2", META_UNIFIED_CONFIG_ID: "8" }).instagram).toEqual({
      appId: "2",
      appSecret: "s",
      configId: "8",
    });
    // O app próprio do Instagram não existe mais: só o segredo do app da Meta confere webhook.
    expect(resolverConfigMetaSocial(null, meta, { META_APP_ID: "2", INSTAGRAM_APP_SECRET: "velho" }).segredos).toEqual(["s"]);
  });
});

describe("callback do Instagram (login unificado)", () => {
  it("conecta TODAS as contas concedidas (paginadas) com o SUAT, assina o webhook e queima o nonce", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    const cookie = assinarVinculoMetaSocial("n-1", SEGREDO);
    const state = emitirEstadoMetaSocial(
      { plataforma: "instagram", organizationId: ORG, userId: USER },
      { segredo: SEGREDO, agora: new Date(), nonce: "n-1" },
    );

    const destino = await chamarComState(state, cookie);
    expect(destino).toContain("meta_social=ok");
    expect(destino).toContain("n=2");
    const sessoes = banco.t("channel_sessions");
    expect(sessoes.map((s) => s.meta_social_account_id).sort()).toEqual(["IG-1", "IG-2"]);
    for (const s of sessoes) {
      expect(s).toMatchObject({
        organization_id: ORG,
        provider: "meta_social",
        meta_social_platform: "instagram",
        meta_social_token_encrypted: "cifrado:SUAT",
        meta_social_token_expires_at: null,
        status: "WORKING",
      });
      expect(s.metadata).toMatchObject({ meta_autorizador_id: "SU-1", meta_client_business_id: "BIZ-1" });
    }

    // Tudo em graph.facebook.com; token nunca na URL; assinatura com os campos no corpo.
    for (const c of meta.chamadas) {
      expect(c.url.startsWith("https://graph.facebook.com/v26.0/")).toBe(true);
      expect(c.url).not.toContain("SUAT");
      expect(c.url).not.toContain("segredo-do-app-da-meta");
    }
    const assinaturas = meta.chamadas.filter((c) => c.url.includes("/subscribed_apps"));
    expect(assinaturas.map((c) => c.url).sort()).toEqual([
      "https://graph.facebook.com/v26.0/IG-1/subscribed_apps",
      "https://graph.facebook.com/v26.0/IG-2/subscribed_apps",
    ]);
    expect(new URLSearchParams(String(assinaturas[0]!.init?.body)).get("subscribed_fields")).toBe(
      "messages,messaging_postbacks,messaging_seen,comments",
    );
    expect((assinaturas[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer SUAT");

    const replay = await chamarComState(state, cookie);
    expect(replay).toContain("meta_social=erro");
    expect(replay).toContain("motivo=retorno_nao_verificavel");
    expect(banco.t("channel_sessions")).toHaveLength(2);
  });

  it("lista vazia, mas a conta está no granular_scopes do debug_token: conecta pelo plano B", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    meta = metaFalsa([[]], ["17841400000000001"]);
    vi.stubGlobal("fetch", meta.fetcher);
    expect(await chamar("n-5b")).toContain("meta_social=ok");
    expect(banco.t("channel_sessions")).toHaveLength(1);
    const debug = meta.chamadas.find((c) => c.url.includes("/debug_token"));
    expect(new Headers(debug?.init?.headers).get("authorization")).toBe("Bearer 12345678|segredo-do-app-da-meta");
  });

  it("assigned e debug_token vazios, mas a Página tem Instagram: conecta pela Página (plano C)", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    meta = metaFalsa(
      [[]],
      [],
      [
        {
          id: "PAG-9",
          name: "Loja Página",
          access_token: "TOKEN-DA-PAGINA",
          instagram_business_account: { id: "17841400000000009", username: "loja_ig" },
        },
        { id: "PAG-SEM-IG", name: "Outra", access_token: "TOKEN-OUTRA" },
      ],
    );
    vi.stubGlobal("fetch", meta.fetcher);

    const destino = await chamar("n-5c");
    expect(destino).toContain("meta_social=ok");
    expect(destino).toContain("n=1");
    const sessoes = banco.t("channel_sessions");
    expect(sessoes).toHaveLength(1);
    expect(sessoes[0]).toMatchObject({
      meta_social_platform: "instagram",
      meta_social_account_id: "17841400000000009",
      meta_social_page_id: "PAG-9",
      meta_social_username: "loja_ig",
      meta_social_token_encrypted: "cifrado:TOKEN-DA-PAGINA",
      meta_social_token_expires_at: null,
      status: "WORKING",
    });
    expect(sessoes[0]!.metadata).toMatchObject({ meta_autorizador_id: "FB-1", nome_da_conta: "Loja Página" });

    // A listagem das Páginas usou o token LONGO, no header (nunca na URL).
    const lista = meta.chamadas.find((c) => c.url.includes("/me/accounts"))!;
    expect(lista.url).not.toContain("LONGO");
    expect(new URL(lista.url).searchParams.get("fields")).toBe(
      "id,name,access_token,instagram_business_account{id,username}",
    );
    expect((lista.init?.headers as Record<string, string>).authorization).toBe("Bearer LONGO");

    // Assinatura na PÁGINA, com o token da Página e os campos da Página.
    const assinaturas = meta.chamadas.filter((c) => c.url.includes("/subscribed_apps"));
    expect(assinaturas.map((c) => c.url)).toEqual([
      "https://graph.facebook.com/v26.0/PAG-9/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes,message_reads",
    ]);
    expect(assinaturas[0]!.init?.method).toBe("POST");
    expect((assinaturas[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer TOKEN-DA-PAGINA");
  });

  it("token de usuário: /me de empresa e assigned recusam, mas a Página conecta (sem empresa, autorizador do Facebook)", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    meta = metaFalsa(
      [[]],
      [],
      [{ id: "PAG-9", name: "Loja", access_token: "TOKEN-DA-PAGINA", instagram_business_account: { id: "17841400000000009" } }],
      true,
    );
    vi.stubGlobal("fetch", meta.fetcher);
    expect(await chamar("n-5f")).toContain("meta_social=ok");
    const [s] = banco.t("channel_sessions");
    expect(s).toMatchObject({ meta_social_account_id: "17841400000000009", meta_social_page_id: "PAG-9" });
    expect(s!.metadata).toMatchObject({ meta_autorizador_id: "FB-1" });
    expect(s!.metadata).not.toHaveProperty("meta_client_business_id");
    // Token de usuário vai direto à Página: assigned e debug_token são do SUAT.
    expect(meta.chamadas.some((c) => c.url.includes("/me/assigned_instagram_accounts"))).toBe(false);
    expect(meta.chamadas.some((c) => c.url.includes("/debug_token"))).toBe(false);
    expect(meta.chamadas.some((c) => c.url.includes("/me/accounts"))).toBe(true);
  });

  it("tudo vazio com token de usuário: detalhe diz que assigned e debug_token não rodaram, e as paginas", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    meta = metaFalsa([[]], [], [], true);
    vi.stubGlobal("fetch", meta.fetcher);
    expect(await chamar("n-5g")).toContain("motivo=nenhuma_conta_instagram");
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.meta_social_connect_failed",
        metadata: expect.objectContaining({
          detalhe:
            "assigned=- debug_token=- escopos= alvos=- paginas=0/0",
        }),
      }),
    );
  });

  it("reconectar pelo SUAT uma conta que veio pela Página limpa o id da Página", async () => {
    const banco = novoBanco();
    banco.t("channel_sessions").push({
      id: "pela-pagina",
      organization_id: ORG,
      provider: "meta_social",
      meta_social_platform: "instagram",
      meta_social_account_id: "IG-1",
      meta_social_page_id: "PAG-9",
      meta_social_token_encrypted: "cifrado:TOKEN-DA-PAGINA",
      status: "WORKING",
      archived_at: null,
      metadata: {},
    });
    h.db = banco.db;
    meta = metaFalsa([[{ id: "IG-1", username: "loja" }]]);
    vi.stubGlobal("fetch", meta.fetcher);
    expect(await chamar("n-5d")).toContain("meta_social=ok");
    expect(banco.t("channel_sessions")[0]).toMatchObject({
      id: "pela-pagina",
      meta_social_page_id: null,
      meta_social_token_encrypted: "cifrado:SUAT",
    });
  });

  it("Páginas sem Instagram: nenhuma_conta_instagram com paginas=1/0 no detalhe, sem token", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    meta = metaFalsa([[]], [], [{ id: "PAG-SEM-IG", name: "Outra", access_token: "TOKEN-OUTRA" }]);
    vi.stubGlobal("fetch", meta.fetcher);
    expect(await chamar("n-5e")).toContain("motivo=nenhuma_conta_instagram");
    expect(banco.t("channel_sessions")).toHaveLength(0);
    const falha = (h.audit.mock.calls as unknown as [{ action: string; metadata: { detalhe?: string } }][])
      .map(([a]) => a)
      .find((a) => a.action === "channel.meta_social_connect_failed");
    expect(falha?.metadata.detalhe).toContain("paginas=1/0");
    expect(falha?.metadata.detalhe).not.toMatch(/TOKEN|SUAT|LONGO|segredo/);
  });

  it("nenhuma conta concedida: motivo nenhuma_conta_instagram, nada conectado", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    meta = metaFalsa([[]]);
    vi.stubGlobal("fetch", meta.fetcher);
    expect(await chamar("n-5")).toContain("motivo=nenhuma_conta_instagram");
    expect(banco.t("channel_sessions")).toHaveLength(0);
    // A listagem das Páginas recusada (sem `pages_show_list`) aparece no diagnóstico.
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.meta_social_connect_failed",
        metadata: expect.objectContaining({ detalhe: expect.stringContaining("paginas=falhou") }),
      }),
    );
  });

  it("limite do plano numa das contas: volta parcial, a outra fica conectada", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    h.podeCriar.mockReset();
    h.podeCriar.mockResolvedValueOnce({ pode: true }).mockResolvedValue({ pode: false });
    const destino = await chamar("n-6");
    expect(destino).toContain("meta_social=parcial");
    expect(destino).toContain("n=1");
    expect(destino).toContain("recusadas=1");
    expect(destino).toContain("motivo=limite_do_plano");
    expect(banco.t("channel_sessions")).toHaveLength(1);
  });

  it("reconectar a mesma conta na mesma organização atualiza a linha, sem duplicar", async () => {
    const banco = novoBanco();
    banco.t("channel_sessions").push({
      id: "existente",
      organization_id: ORG,
      provider: "meta_social",
      meta_social_platform: "instagram",
      meta_social_account_id: "IG-1",
      meta_social_token_encrypted: "cifrado:VELHO",
      status: "FAILED",
      status_reason: "token_invalido",
      archived_at: null,
      metadata: {},
    });
    h.db = banco.db;
    meta = metaFalsa([[{ id: "IG-1", username: "loja" }]]);
    vi.stubGlobal("fetch", meta.fetcher);
    expect(await chamar("n-7")).toContain("meta_social=ok");
    const sessoes = banco.t("channel_sessions");
    expect(sessoes).toHaveLength(1);
    expect(sessoes[0]).toMatchObject({
      id: "existente",
      meta_social_token_encrypted: "cifrado:SUAT",
      status: "WORKING",
      status_reason: null,
    });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.reconnected" }));
  });

  it("vínculo de outro navegador não conecta", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    expect(await chamar("n-2", assinarVinculoMetaSocial("outro-nonce", SEGREDO))).toContain(
      "motivo=retorno_nao_verificavel",
    );
    expect(banco.t("channel_sessions")).toHaveLength(0);
    expect(meta.fetcher).not.toHaveBeenCalled();
  });

  it("quem deixou de ser admin da organização não conecta", async () => {
    const banco = bancoFalso({
      user_organizations: [{ organization_id: ORG, user_id: USER, role: "agent", revoked_at: null }],
    });
    h.db = banco.db;
    expect(await chamar("n-3")).toContain("motivo=sem_permissao");
    expect(banco.t("channel_sessions")).toHaveLength(0);
  });

  it("conta ativa em OUTRA organização é recusada", async () => {
    const banco = novoBanco();
    banco.t("channel_sessions").push({
      id: "da-outra",
      organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      provider: "meta_social",
      meta_social_platform: "instagram",
      meta_social_account_id: "IG-1",
      archived_at: null,
    });
    h.db = banco.db;
    meta = metaFalsa([[{ id: "IG-1", username: "loja" }]]);
    vi.stubGlobal("fetch", meta.fetcher);
    expect(await chamar("n-4")).toContain("motivo=conta_em_outra_organizacao");
    expect(banco.t("channel_sessions")).toHaveLength(1);
  });
});
