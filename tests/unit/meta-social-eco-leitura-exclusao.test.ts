/**
 * Canal social oficial: eco do próprio envio sem `app_id`, leitura, webhook
 * que falha → 500, exclusão de dados (frescor, idempotência, execução),
 * aviso de validade sem sobrescrever reconexão, motivos da volta, frase de falha.
 * Contra o banco em memória com as restrições únicas reais.
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

process.env.META_APP_SECRET = "segredo-do-app";
process.env.META_APP_ID = "12345678";
process.env.META_WEBHOOK_VERIFY_TOKEN = "token-de-verificacao";

const h = vi.hoisted(() => ({ db: null as unknown, audit: vi.fn(async (_e: Record<string, unknown>) => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn(async () => undefined) }));
vi.mock("@/lib/plataformas-de-anuncio/google/atribuicao", () => ({
  extrairEEstamparAtribuicaoGoogle: vi.fn(async () => undefined),
}));

import { NextRequest } from "next/server";
import { invalidarAppDaMeta } from "@/lib/channels/meta/app";
import { metaSocialAdapter } from "@/lib/channels/meta-social/adapter";
import { invalidarConfigMetaSocial } from "@/lib/channels/meta-social/config";
import {
  executarPedidoDeExclusao,
  lerSignedRequest,
  registrarPedidoDeExclusao,
} from "@/lib/channels/meta-social/exclusao";
import { ingerirEventoMetaSocial, sessaoPelaConta } from "@/lib/channels/meta-social/ingest";
import { FRASES_DOS_MOTIVOS, MOTIVOS_DA_VOLTA, fraseDoMotivo } from "@/lib/channels/meta-social/motivos";
import { ErroDaMeta, chamarMeta } from "@/lib/channels/meta-social/oauth";
import { marcarTokensPertoDeVencer } from "@/lib/channels/meta-social/renovacao";
import type { EventoMetaSocial } from "@/lib/channels/meta-social/webhook";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessao = {
  id: "s1",
  organization_id: ORG,
  provider: "meta_social",
  meta_social_platform: "instagram",
  meta_social_account_id: "IG-A",
  meta_social_token_encrypted: "cifrado:TOKEN-SECRETO",
  archived_at: null,
  metadata: {},
};

const msg = (over: Partial<Extract<EventoMetaSocial, { tipo: "mensagem" }>> = {}): EventoMetaSocial => ({
  tipo: "mensagem",
  plataforma: "instagram",
  contaId: "IG-A",
  clienteId: "IGSID-1",
  mid: "mid.1",
  direcao: "inbound",
  texto: "oi",
  anexos: [],
  enviadaEm: "2026-11-02T12:00:00.000Z",
  appId: null,
  ...over,
});

beforeEach(() => {
  h.audit.mockClear();
  vi.mocked(pausarIaPorAtendimentoManual).mockClear();
  invalidarAppDaMeta();
  invalidarConfigMetaSocial();
});
afterEach(() => vi.unstubAllGlobals());

describe("eco do próprio envio sem app_id", () => {
  it("o adapter registra TODO mid (pedaços); o eco de qualquer pedaço é ignorado e não pausa a IA", async () => {
    const banco = bancoFalso({ channel_sessions: [sessao] });
    h.db = banco.db;
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message_id: `mid.p${++n}` }), { status: 200 })),
    );
    const r = await metaSocialAdapter.send({
      organizationId: ORG,
      sessionRef: "IG-A",
      to: "provider-thread",
      kind: "text",
      body: "palavra ".repeat(300),
      providerConversationId: "IGSID-1",
    });
    expect(n).toBeGreaterThan(1);
    expect(r.externalId).toBe(`mid.p${n}`);
    expect(banco.t("meta_social_envios").map((e) => e.mid)).toEqual(
      Array.from({ length: n }, (_, i) => `mid.p${i + 1}`),
    );

    const s = (await sessaoPelaConta(banco.db, "instagram", "IG-A"))!;
    for (let i = 1; i <= n; i++) {
      const d = await ingerirEventoMetaSocial(
        banco.db,
        s,
        msg({ direcao: "outbound", mid: `mid.p${i}`, appId: null }),
        { appIdsProprios: ["12345678"] },
      );
      expect(d).toEqual({ status: "ignored", reason: "eco_do_proprio_envio" });
    }
    expect(banco.t("messages")).toHaveLength(0);
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("mid já gravado como external_id de mensagem da organização também é eco", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessao],
      messages: [{ id: "m1", organization_id: ORG, external_id: "mid.ultimo", direction: "outbound" }],
    });
    const s = (await sessaoPelaConta(banco.db, "instagram", "IG-A"))!;
    const d = await ingerirEventoMetaSocial(banco.db, s, msg({ direcao: "outbound", mid: "mid.ultimo" }), {
      appIdsProprios: [],
    });
    expect(d.reason).toBe("eco_do_proprio_envio");
    expect(banco.t("messages")).toHaveLength(1);
  });

  it("mid de OUTRA organização não conta como nosso", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessao],
      meta_social_envios: [{ organization_id: ORG_B, channel_session_id: "x", mid: "mid.alheio" }],
    });
    const s = (await sessaoPelaConta(banco.db, "instagram", "IG-A"))!;
    const d = await ingerirEventoMetaSocial(banco.db, s, msg({ direcao: "outbound", mid: "mid.alheio" }), {
      appIdsProprios: [],
    });
    expect(d.status).toBe("ingested");
  });

  it("erro da Meta no envio vira frase para o operador, sem o texto cru dela", async () => {
    h.db = bancoFalso({ channel_sessions: [sessao] }).db;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 190, message: "Error validating access token: XYZ-INTERNO" } }), {
          status: 400,
        }),
      ),
    );
    const envio = metaSocialAdapter.send({
      organizationId: ORG,
      sessionRef: "IG-A",
      to: "provider-thread",
      kind: "text",
      body: "oi",
      providerConversationId: "IGSID-1",
    });
    await expect(envio).rejects.toThrow(/Reconecte em Conexões/);
    await expect(envio).rejects.not.toThrow(/XYZ-INTERNO/);
  });
});

describe("leitura", () => {
  it("Instagram (mid): carimba read_at e delivered_at uma vez só", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessao],
      messages: [
        { id: "m1", organization_id: ORG, channel_session_id: "s1", external_id: "mid.x", direction: "outbound", read_at: null, delivered_at: null },
      ],
    });
    const s = (await sessaoPelaConta(banco.db, "instagram", "IG-A"))!;
    const ev: EventoMetaSocial = { tipo: "lida", plataforma: "instagram", contaId: "IG-A", clienteId: "IGSID-1", mid: "mid.x", ateMs: null, lidaEm: "2026-11-02T13:00:00.000Z" };
    expect(await ingerirEventoMetaSocial(banco.db, s, ev, { appIdsProprios: [] })).toEqual({ status: "ingested", reason: "lida" });
    expect(banco.t("messages")[0]).toMatchObject({ read_at: "2026-11-02T13:00:00.000Z", delivered_at: "2026-11-02T13:00:00.000Z" });
    const depois = await ingerirEventoMetaSocial(banco.db, s, { ...ev, lidaEm: "2026-11-02T14:00:00.000Z" }, { appIdsProprios: [] });
    expect(depois.status).toBe("ignored");
    expect(banco.t("messages")[0]!.read_at).toBe("2026-11-02T13:00:00.000Z");
  });

  it("Messenger (marca d'água): só a saída da conversa até a marca", async () => {
    const sm = { ...sessao, id: "s2", meta_social_platform: "messenger", meta_social_account_id: "PAG" };
    const banco = bancoFalso({
      channel_sessions: [sm],
      conversations: [{ id: "c1", organization_id: ORG, channel_session_id: "s2", provider_conversation_id: "PSID" }],
      messages: [
        { id: "antes", organization_id: ORG, channel_session_id: "s2", conversation_id: "c1", direction: "outbound", created_at: "2026-11-02T10:00:00.000Z", read_at: null },
        { id: "depois", organization_id: ORG, channel_session_id: "s2", conversation_id: "c1", direction: "outbound", created_at: "2026-11-02T12:00:00.000Z", read_at: null },
        { id: "entrada", organization_id: ORG, channel_session_id: "s2", conversation_id: "c1", direction: "inbound", created_at: "2026-11-02T09:00:00.000Z", read_at: null },
      ],
    });
    const s = (await sessaoPelaConta(banco.db, "messenger", "PAG"))!;
    await ingerirEventoMetaSocial(
      banco.db,
      s,
      { tipo: "lida", plataforma: "messenger", contaId: "PAG", clienteId: "PSID", mid: null, ateMs: Date.parse("2026-11-02T11:00:00.000Z"), lidaEm: null },
      { appIdsProprios: [] },
    );
    const porId = Object.fromEntries(banco.t("messages").map((m) => [m.id, m]));
    expect(porId.antes!.read_at).toBeTruthy();
    expect(porId.depois!.read_at).toBeNull();
    expect(porId.entrada!.read_at).toBeNull();
  });
});

describe("webhook: falha nossa é 500, fora do contrato é 200", () => {
  const assinado = (texto: string) =>
    new NextRequest("https://crm.exemplo/api/v1/webhooks/meta-social", {
      method: "POST",
      body: texto,
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "segredo-do-app").update(texto).digest("hex")}` },
    });
  const corpo = JSON.stringify({
    object: "instagram",
    entry: [{ id: "IG-A", messaging: [{ sender: { id: "IGSID" }, recipient: { id: "IG-A" }, message: { mid: "m.1", text: "oi" } }] }],
  });

  it("ingestão lança (escrita/lookup) → 500, para a Meta reentregar", async () => {
    const banco = bancoFalso({ channel_sessions: [sessao] });
    const quebrado = {
      ...banco.db,
      from: (t: string) => {
        if (t === "channel_sessions") return banco.db.from(t);
        throw new Error("banco fora do ar");
      },
    };
    h.db = quebrado;
    const { POST } = await import("@/app/api/v1/webhooks/meta-social/route");
    const r = await POST(assinado(corpo));
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ outcomes: ["failed"] });
  });

  it("envelope assinado com entrada sem entry[].id → 200 ignorado, não 400", async () => {
    h.db = bancoFalso().db;
    const { POST } = await import("@/app/api/v1/webhooks/meta-social/route");
    const r = await POST(assinado(JSON.stringify({ object: "instagram", entry: [{ messaging: [] }] })));
    expect(r.status).toBe(200);
    const r2 = await POST(assinado(JSON.stringify({ object: 1, entry: "x" })));
    expect(r2.status).toBe(200);
  });
});

describe("exclusão de dados", () => {
  const agora = new Date("2026-11-02T12:00:00Z");
  const assinar = (carga: object, segredo = "meta") => {
    const c = Buffer.from(JSON.stringify(carga)).toString("base64url");
    return `${createHmac("sha256", segredo).update(c).digest("base64url")}.${c}`;
  };
  const emitido = Math.floor(agora.getTime() / 1000) - 60;

  it("recusa sem issued_at, com issued_at de mais de 24h ou no futuro", () => {
    expect(lerSignedRequest(assinar({ user_id: "1" }), ["meta"], agora)).toBeNull();
    expect(lerSignedRequest(assinar({ user_id: "1", issued_at: emitido - 25 * 3600 }), ["meta"], agora)).toBeNull();
    expect(lerSignedRequest(assinar({ user_id: "1", issued_at: emitido + 3600 }), ["meta"], agora)).toBeNull();
    expect(lerSignedRequest(assinar({ user_id: "1", issued_at: emitido }), ["meta"], agora)).toMatchObject({ userId: "1" });
  });

  it("reentrega: mesmo código, sem linha nova; repetida depois de cumprida também", async () => {
    const banco = bancoFalso();
    const entrada = { plataforma: "instagram" as const, userId: "U1", emitidoEm: "2026-11-02T11:59:00.000Z" };
    const a = await registrarPedidoDeExclusao(banco.db, entrada);
    const b = await registrarPedidoDeExclusao(banco.db, entrada);
    expect(a.novo).toBe(true);
    expect(b).toMatchObject({ codigo: a.codigo, novo: false, concluido: false });
    expect(banco.t("meta_data_deletion_requests")).toHaveLength(1);
    await executarPedidoDeExclusao(banco.db, { id: a.id, plataforma: "instagram", userId: "U1" }, { arquivar: vi.fn() });
    const c = await registrarPedidoDeExclusao(banco.db, entrada);
    expect(c).toMatchObject({ codigo: a.codigo, novo: false, concluido: true });
    expect(banco.t("meta_data_deletion_requests")).toHaveLength(1);
  });

  it("cumpre: arquiva as sessões autorizadas pela pessoa ou da conta dela, nas duas redes (um app só), em cada organização; marca concluído", async () => {
    const banco = bancoFalso({
      channel_sessions: [
        { ...sessao, id: "pelo-autorizador", metadata: { meta_autorizador_id: "U1" } },
        { ...sessao, id: "pela-conta", organization_id: ORG_B, meta_social_account_id: "U1", metadata: {} },
        { ...sessao, id: "alheia", meta_social_account_id: "IG-Z", metadata: { meta_autorizador_id: "U9" } },
        { ...sessao, id: "outra-rede", meta_social_platform: "messenger", metadata: { meta_autorizador_id: "U1" } },
      ],
    });
    h.db = banco.db;
    const p = await registrarPedidoDeExclusao(banco.db, { plataforma: "instagram", userId: "U1", emitidoEm: agora.toISOString() });
    const desassinar = vi.fn(async () => undefined);
    const { arquivarConta } = await import("@/lib/channels/meta-social/store");
    const r = await executarPedidoDeExclusao(
      banco.db,
      { id: p.id, plataforma: "instagram", userId: "U1" },
      { arquivar: (a, o, i) => arquivarConta(a, o, i, desassinar) },
    );
    // Desde o login unificado (0988) Instagram e Messenger são o MESMO app da
    // Meta: o id app-scoped é o mesmo, e o pedido vale para as duas redes.
    expect(r.arquivadas.map((x) => x.sessionId).sort()).toEqual(["outra-rede", "pela-conta", "pelo-autorizador"]);
    const porId = Object.fromEntries(banco.t("channel_sessions").map((l) => [l.id, l]));
    for (const id of ["outra-rede", "pela-conta", "pelo-autorizador"]) {
      expect(porId[id]!.archived_at).toBeTruthy();
      expect(porId[id]!.meta_social_token_encrypted).toBeNull();
    }
    expect(porId.alheia!.archived_at).toBeNull();
    expect(desassinar).toHaveBeenCalledTimes(3);
    expect(banco.t("meta_data_deletion_requests")[0]).toMatchObject({ status: "completed" });
    expect(banco.t("meta_data_deletion_requests")[0]!.completed_at).toBeTruthy();
    const trilhas = h.audit.mock.calls.map(([e]) => e).filter((e) => e.action === "meta.data_deletion_executed");
    expect(trilhas.map((e) => e.organizationId).sort()).toEqual([ORG, ORG, ORG_B].sort());
  });

  it("nada casou: concluído sem efeito", async () => {
    const banco = bancoFalso({ channel_sessions: [sessao] });
    const p = await registrarPedidoDeExclusao(banco.db, { plataforma: "instagram", userId: "NINGUEM", emitidoEm: agora.toISOString() });
    const r = await executarPedidoDeExclusao(banco.db, { id: p.id, plataforma: "instagram", userId: "NINGUEM" });
    expect(r.arquivadas).toEqual([]);
    expect(banco.t("meta_data_deletion_requests")[0]!.status).toBe("completed");
    expect(banco.t("channel_sessions")[0]!.archived_at).toBeNull();
  });

  it("a rota: reentrega devolve o mesmo código e não audita 'recebido' de novo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(agora);
    try {
      h.db = bancoFalso().db;
      const { POST } = await import("@/app/api/v1/meta/exclusao-de-dados/route");
      const pedir = () =>
        POST(
          new NextRequest("https://crm.exemplo/api/v1/meta/exclusao-de-dados", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `signed_request=${assinar({ algorithm: "HMAC-SHA256", user_id: "U7", issued_at: emitido }, "segredo-do-app")}`,
          }),
        );
      const r1 = await (await pedir()).json();
      const r2 = await (await pedir()).json();
      expect(r2.confirmation_code).toBe(r1.confirmation_code);
      expect(h.audit.mock.calls.filter(([e]) => e.action === "meta.data_deletion_requested")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("aviso de validade: reconexão no meio não é sobrescrita", () => {
  const agora = new Date("2026-11-02T06:35:00Z");
  const dia = 24 * 3600 * 1000;
  const linha = (id: string) => ({
    ...sessao,
    id,
    meta_social_account_id: id,
    status: "WORKING",
    status_reason: null,
    meta_social_token_expires_at: new Date(agora.getTime() + 5 * dia).toISOString(),
    meta_social_token_refreshed_at: new Date(agora.getTime() - 50 * dia).toISOString(),
  });

  it("a conta reconectada entre a leitura e a escrita não é marcada; as outras são", async () => {
    const banco = bancoFalso({ channel_sessions: [linha("a"), linha("b")] });
    let mexeu = false;
    // A pessoa reconecta "b" depois que a rodada leu as linhas.
    const db = new Proxy(banco.db, {
      get(alvo, p) {
        if (p !== "from") return Reflect.get(alvo, p);
        return (nome: string) => {
          const q = alvo.from(nome) as unknown as { update: (v: unknown) => unknown };
          const original = q.update.bind(q);
          q.update = (v: unknown) => {
            if (!mexeu) {
              mexeu = true;
              Object.assign(banco.t("channel_sessions").find((l) => l.id === "b")!, {
                meta_social_token_refreshed_at: agora.toISOString(),
                meta_social_token_expires_at: null,
              });
            }
            return original(v);
          };
          return q;
        };
      },
    });
    const r = await marcarTokensPertoDeVencer(db, agora);
    expect(r).toEqual({ examinadas: 2, marcadas: 1 });
    const porId = Object.fromEntries(banco.t("channel_sessions").map((l) => [l.id, l]));
    expect(porId.a).toMatchObject({ status: "FAILED", status_reason: "token_vence_em_breve" });
    expect(porId.b).toMatchObject({ status: "WORKING", status_reason: null });
  });
});

describe("motivos da volta do OAuth: um conjunto só", () => {
  const ROTAS = [
    "app/api/v1/channels/meta-social/conectar/route.ts",
    "app/api/v1/channels/meta-social/callback/[plataforma]/route.ts",
  ];
  it("todo código que as rotas e o store emitem tem frase", () => {
    const emitidos = new Set<string>();
    for (const rel of [...ROTAS, "lib/channels/meta-social/store.ts"]) {
      const fonte = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      for (const m of fonte.matchAll(/(?:erro|falhou|recusouSemVinculo|registrarFalha|ConexaoRecusada)\(\s*"([a-z_]+)"/g))
        emitidos.add(m[1]!);
    }
    expect(emitidos.size).toBeGreaterThanOrEqual(10);
    for (const c of emitidos) expect(MOTIVOS_DA_VOLTA, c).toContain(c);
    for (const c of MOTIVOS_DA_VOLTA) expect(FRASES_DOS_MOTIVOS[c].length).toBeGreaterThan(20);
  });
  it("código desconhecido cai na frase genérica, nunca no código cru", () => {
    expect(fraseDoMotivo("xyz")).toBe(FRASES_DOS_MOTIVOS.falha_inesperada);
    expect(fraseDoMotivo(null)).toBe(FRASES_DOS_MOTIVOS.falha_inesperada);
  });
});

describe("chamada à Meta não vaza a URL", () => {
  it("falha de rede cuja mensagem cita a URL com o segredo: o erro leva só o nome", async () => {
    const url = "https://graph.facebook.com/v26.0/oauth/access_token?client_secret=SEGREDO&access_token=TOKEN";
    const err = await chamarMeta("instagram_troca_de_codigo", url, {}, (async () => {
      throw new TypeError(`fetch failed for ${url}`);
    }) as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErroDaMeta);
    expect(String((err as Error).message)).not.toContain("SEGREDO");
    expect(String((err as Error).message)).not.toContain("TOKEN");
  });
});
