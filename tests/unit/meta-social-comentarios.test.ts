/**
 * Comentários do Instagram (0991): a entrada pelo webhook, as três ações do
 * canal e a fila com ritmo. O banco é o em memória dos testes do canal (o lugar
 * onde o código escreve); a Meta é um `fetch` falso que registra o que recebeu.
 * O que a função SQL da 0991 faz de verdade é provado em
 * tests/invariants/instagram-comentarios.test.ts.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

process.env.META_APP_SECRET = "segredo-do-app";
process.env.META_WEBHOOK_VERIFY_TOKEN = "token-de-verificacao";

const h = vi.hoisted(() => ({ db: null as unknown, audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/v1/webhooks/meta-social/route";
import { invalidarAppDaMeta } from "@/lib/channels/meta/app";
import { invalidarConfigMetaSocial } from "@/lib/channels/meta-social/config";
import {
  conferirSeSegue,
  lerComentariosMetaSocial,
  pedirRespostaPrivada,
  responderNoComentario,
} from "@/lib/channels/meta-social/comentarios";
import { TETO_DE_RESPOSTAS_PRIVADAS_POR_HORA } from "@/lib/channels/meta-social/comentarios-contrato";
import { processarFilaMetaSocial } from "@/lib/channels/meta-social/fila";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IG = "17841400000000001";
const AGORA = new Date("2026-11-03T12:00:00.000Z");

const sessaoA = {
  id: "sessao-a",
  organization_id: ORG_A,
  provider: "meta_social",
  meta_social_platform: "instagram",
  meta_social_account_id: IG,
  meta_social_page_id: "PAG-1",
  meta_social_token_encrypted: "cifrado:TOKEN-DA-PAGINA",
  archived_at: null,
  status: "WORKING",
  status_reason: null,
};
const sessaoB = {
  ...sessaoA,
  id: "sessao-b",
  organization_id: ORG_B,
  meta_social_account_id: "17841400000000002",
  meta_social_page_id: "PAG-2",
  meta_social_token_encrypted: "cifrado:TOKEN-B",
};

const comentario = (commentId: string, extra: Record<string, unknown> = {}) => ({
  id: `linha-${commentId}`,
  organization_id: ORG_A,
  channel_session_id: "sessao-a",
  comment_id: commentId,
  autor_id: "IGSID-1",
  criado_na_meta_em: new Date(AGORA.getTime() - 60_000).toISOString(),
  recebido_em: new Date(AGORA.getTime() - 60_000).toISOString(),
  resposta_privada_status: "nao_pedida",
  ...extra,
});

const naFila = (commentId: string, tipo: "resposta_privada" | "resposta_publica", extra: Record<string, unknown> = {}) => ({
  id: `fila-${tipo}-${commentId}`,
  organization_id: ORG_A,
  channel_session_id: "sessao-a",
  tipo,
  comment_id: commentId,
  texto: tipo === "resposta_privada" ? "Te mandei no Direct!" : "Olha o Direct 😉",
  pedido_por: "execucao-1",
  status: "na_fila",
  tentativas: 0,
  proxima_tentativa_em: new Date(AGORA.getTime() - 1000).toISOString(),
  criado_em: new Date(AGORA.getTime() - 5000).toISOString(),
  atualizado_em: new Date(AGORA.getTime() - 5000).toISOString(),
  ...extra,
});

/** A Meta falsa: responde por URL e guarda cada chamada. */
function metaFalsa(responder: (url: string, body: string) => { status: number; corpo: unknown }) {
  const chamadas: { url: string; body: string; auth: string | undefined }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = String(init?.body ?? "");
    chamadas.push({ url: u, body, auth: (init?.headers as Record<string, string>)?.authorization });
    const r = responder(u, body);
    return new Response(JSON.stringify(r.corpo), { status: r.status });
  });
  return { fetcher: fetcher as unknown as typeof fetch, chamadas };
}

const okMeta = () =>
  metaFalsa((url) =>
    url.endsWith("/replies") ? { status: 200, corpo: { id: "reply-1" } } : { status: 200, corpo: { recipient_id: "IGSID-1", message_id: "mid.priv" } },
  );

beforeEach(() => {
  h.audit.mockClear();
  invalidarAppDaMeta();
  invalidarConfigMetaSocial();
});
afterEach(() => vi.unstubAllGlobals());

// ─── Entrada ────────────────────────────────────────────────────────────────

const envelope = (valores: Record<string, unknown>[], conta = IG) => ({
  object: "instagram",
  // Campo forjado: a organização NUNCA sai do corpo.
  organization_id: ORG_B,
  entry: [{ id: conta, time: 1_762_171_200, changes: valores.map((value) => ({ field: "comments", value })) }],
});
const post = (corpo: object) => {
  const texto = JSON.stringify(corpo);
  return POST(
    new NextRequest("https://crm.exemplo/api/v1/webhooks/meta-social", {
      method: "POST",
      body: texto,
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "segredo-do-app").update(texto).digest("hex")}` },
    }),
  );
};
const valor = (commentId: string, extra: Record<string, unknown> = {}) => ({
  comment_id: commentId,
  text: "quero",
  from: { id: "IGSID-1", username: "maria" },
  media: { id: "MEDIA-1", media_product_type: "REELS" },
  ...extra,
});

describe("entrada do comentário pelo webhook", () => {
  it("comentário novo: uma linha na organização da SESSÃO e um evento", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA, sessaoB] });
    h.db = banco.db;
    const res = await post(envelope([valor("C-1")]));
    expect(res.status).toBe(200);
    expect(banco.t("meta_social_comentarios")).toHaveLength(1);
    expect(banco.t("meta_social_comentarios")[0]).toMatchObject({
      organization_id: ORG_A,
      channel_session_id: "sessao-a",
      comment_id: "C-1",
      autor_id: "IGSID-1",
      autor_usuario: "maria",
      texto: "quero",
      media_id: "MEDIA-1",
      media_product_type: "REELS",
      criado_na_meta_em: "2025-11-03T12:00:00.000Z",
    });
    expect(banco.t("event_log")).toEqual([
      expect.objectContaining({ organization_id: ORG_A, event_type: "instagram.comentario_recebido" }),
    ]);
  });

  it("comentário repetido (reentrega da Meta): nenhuma linha nem evento novos", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    h.db = banco.db;
    await post(envelope([valor("C-1")]));
    const res = await post(envelope([valor("C-1")]));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcomes: string[] }).outcomes).toEqual(["duplicate:comentario"]);
    expect(banco.t("meta_social_comentarios")).toHaveLength(1);
    expect(banco.t("event_log")).toHaveLength(1);
  });

  it("comentário da própria conta e resposta a comentário são ignorados", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    h.db = banco.db;
    await post(envelope([valor("C-PROPRIO", { from: { id: IG, username: "loja" } }), valor("C-FILHO", { parent_id: "C-1" })]));
    expect(banco.t("meta_social_comentarios")).toHaveLength(0);
    expect(banco.t("event_log")).toHaveLength(0);
  });

  it("conta desconhecida é 200 ignorado, sem linha", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    h.db = banco.db;
    const res = await post(envelope([valor("C-1")], "999"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcomes: string[] }).outcomes).toEqual(["ignored:conta_desconhecida"]);
    expect(banco.t("meta_social_comentarios")).toHaveLength(0);
  });

  it("lê os dois formatos da doc (comment_id no login unificado, id direto na entrada) e ignora live_comments", () => {
    const lidos = lerComentariosMetaSocial({
      object: "instagram",
      entry: [
        { id: IG, changes: [{ field: "live_comments", value: valor("C-LIVE") }] },
        { id: IG, field: "comments", value: { id: "C-2", text: "oi", from: { id: "IGSID-2" }, media: { id: "M" } } },
      ],
    } as never);
    expect(lidos.map((c) => c.commentId)).toEqual(["C-2"]);
    expect(lerComentariosMetaSocial({ object: "page", entry: [{ id: IG, changes: [{ field: "comments", value: valor("C") }] }] } as never)).toEqual([]);
  });
});

// ─── As ações ───────────────────────────────────────────────────────────────

describe("pedirRespostaPrivada", () => {
  it("põe na fila uma vez; o segundo pedido é ja_pedida (idempotente)", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA], meta_social_comentarios: [comentario("C-1")] });
    const pedido = { organizationId: ORG_A, commentId: "C-1", texto: "Te mandei!", pedidoPor: "exec-1" };
    expect(await pedirRespostaPrivada(banco.db, pedido, { agora: AGORA })).toEqual({ status: "na_fila" });
    expect(await pedirRespostaPrivada(banco.db, pedido, { agora: AGORA })).toEqual({ status: "ja_pedida" });
    expect(banco.t("meta_social_fila_de_envio")).toEqual([
      expect.objectContaining({ tipo: "resposta_privada", comment_id: "C-1", organization_id: ORG_A, pedido_por: "exec-1" }),
    ]);
    expect(banco.t("meta_social_comentarios")[0]!.resposta_privada_status).toBe("na_fila");
  });

  it("comentário com 7 dias ou mais é expirada e não entra na fila", async () => {
    const velho = new Date(AGORA.getTime() - 7 * 24 * 3600_000 - 1).toISOString();
    const banco = bancoFalso({
      meta_social_comentarios: [comentario("C-1", { criado_na_meta_em: velho, recebido_em: velho })],
    });
    expect(
      await pedirRespostaPrivada(banco.db, { organizationId: ORG_A, commentId: "C-1", texto: "oi" }, { agora: AGORA }),
    ).toEqual({ status: "expirada" });
    expect(banco.t("meta_social_fila_de_envio")).toHaveLength(0);
    expect(banco.t("meta_social_comentarios")[0]!.resposta_privada_status).toBe("expirada");
  });

  it("comentário de outra organização é nao_encontrado, sem linha na fila", async () => {
    const banco = bancoFalso({ meta_social_comentarios: [comentario("C-1")] });
    expect(
      await pedirRespostaPrivada(banco.db, { organizationId: ORG_B, commentId: "C-1", texto: "oi" }, { agora: AGORA }),
    ).toEqual({ status: "nao_encontrado" });
    expect(banco.t("meta_social_fila_de_envio")).toHaveLength(0);
  });

  it("texto vazio ou acima de 1000 bytes lança meta_social_texto_invalido, sem linha na fila", async () => {
    const banco = bancoFalso({ meta_social_comentarios: [comentario("C-1")] });
    const p = (texto: string) =>
      pedirRespostaPrivada(banco.db, { organizationId: ORG_A, commentId: "C-1", texto }, { agora: AGORA });
    await expect(p("   ")).rejects.toThrow("meta_social_texto_invalido");
    await expect(p("ç".repeat(501))).rejects.toThrow("meta_social_texto_invalido");
    await expect(
      responderNoComentario(banco.db, { organizationId: ORG_A, commentId: "C-1", texto: "" }),
    ).rejects.toThrow("meta_social_texto_invalido");
    expect(banco.t("meta_social_fila_de_envio")).toHaveLength(0);
  });

});

describe("responderNoComentario", () => {
  it("vai para a fila uma vez por comentário; outra organização é nao_encontrado", async () => {
    const banco = bancoFalso({ meta_social_comentarios: [comentario("C-1")] });
    const p = { organizationId: ORG_A, commentId: "C-1", texto: "Olha o Direct" };
    expect(await responderNoComentario(banco.db, p)).toEqual({ status: "na_fila" });
    expect(await responderNoComentario(banco.db, p)).toEqual({ status: "ja_pedida" });
    expect(await responderNoComentario(banco.db, { ...p, organizationId: ORG_B })).toEqual({ status: "nao_encontrado" });
    expect(banco.t("meta_social_fila_de_envio")).toEqual([expect.objectContaining({ tipo: "resposta_publica" })]);
  });
});

describe("conferirSeSegue", () => {
  it("pergunta is_user_follow_business com o token da conta, no header", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const meta = metaFalsa(() => ({ status: 200, corpo: { is_user_follow_business: true } }));
    expect(
      await conferirSeSegue(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a", autorId: "IGSID-1" }, { fetcher: meta.fetcher }),
    ).toEqual({ segue: true });
    expect(meta.chamadas[0]!.url).toBe("https://graph.facebook.com/v26.0/IGSID-1?fields=is_user_follow_business");
    expect(meta.chamadas[0]!.auth).toBe("Bearer TOKEN-DA-PAGINA");
  });

  it("Meta recusa (pessoa que só comentou, sem consentimento) → null; não segue → false", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const recusa = metaFalsa(() => ({ status: 400, corpo: { error: { code: 230, message: "User consent is required" } } }));
    expect(
      await conferirSeSegue(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a", autorId: "IGSID-1" }, { fetcher: recusa.fetcher }),
    ).toEqual({ segue: null });
    const nao = metaFalsa(() => ({ status: 200, corpo: { is_user_follow_business: false } }));
    expect(
      await conferirSeSegue(banco.db, { organizationId: ORG_A, channelSessionId: "sessao-a", autorId: "IGSID-1" }, { fetcher: nao.fetcher }),
    ).toEqual({ segue: false });
  });

  it("sessão de outra organização → null, e a Meta nem é chamada", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const meta = okMeta();
    expect(
      await conferirSeSegue(banco.db, { organizationId: ORG_B, channelSessionId: "sessao-a", autorId: "IGSID-1" }, { fetcher: meta.fetcher }),
    ).toEqual({ segue: null });
    expect(meta.chamadas).toHaveLength(0);
  });
});

// ─── A fila ─────────────────────────────────────────────────────────────────

describe("fila: envio", () => {
  it("resposta privada vai à Página com recipient.comment_id; grava enviada e registra o mid", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1", { resposta_privada_status: "na_fila" })],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    const meta = okMeta();
    const r = await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher);
    expect(r).toMatchObject({ enviadas: 1, falharam: 0 });
    expect(meta.chamadas[0]!.url).toBe("https://graph.facebook.com/v26.0/PAG-1/messages");
    expect(JSON.parse(meta.chamadas[0]!.body)).toEqual({
      recipient: { comment_id: "C-1" },
      message: { text: "Te mandei no Direct!" },
    });
    expect(meta.chamadas[0]!.url).not.toContain("TOKEN");
    expect(banco.t("meta_social_fila_de_envio")[0]).toMatchObject({ status: "enviada", resultado_id: "mid.priv", tentativas: 1 });
    expect(banco.t("meta_social_comentarios")[0]).toMatchObject({ resposta_privada_status: "enviada", resposta_privada_mid: "mid.priv" });
    expect(banco.t("meta_social_envios")).toEqual([expect.objectContaining({ mid: "mid.priv", organization_id: ORG_A })]);
  });

  it("o teto de 600 por hora por conta: o 601º não sai, e outra conta não é afetada", async () => {
    const enviadasNaHora = Array.from({ length: TETO_DE_RESPOSTAS_PRIVADAS_POR_HORA - 1 }, (_, i) =>
      naFila(`V-${i}`, "resposta_privada", {
        status: "enviada",
        enviada_em: new Date(AGORA.getTime() - 50 * 60_000 + i).toISOString(),
      }),
    );
    // Uma enviada há 61 minutos: fora da janela, não conta.
    const foraDaJanela = naFila("V-velha", "resposta_privada", {
      status: "enviada",
      enviada_em: new Date(AGORA.getTime() - 61 * 60_000).toISOString(),
    });
    const banco = bancoFalso({
      channel_sessions: [sessaoA, sessaoB],
      meta_social_comentarios: [
        comentario("C-600"),
        comentario("C-601"),
        comentario("C-B", { organization_id: ORG_B, channel_session_id: "sessao-b" }),
      ],
      meta_social_fila_de_envio: [
        ...enviadasNaHora,
        foraDaJanela,
        naFila("C-600", "resposta_privada", { criado_em: "2026-11-03T11:00:00.001Z" }),
        naFila("C-601", "resposta_privada", { criado_em: "2026-11-03T11:00:00.002Z" }),
        naFila("C-B", "resposta_privada", { organization_id: ORG_B, channel_session_id: "sessao-b", criado_em: "2026-11-03T11:00:00.003Z" }),
      ],
    });
    const meta = okMeta();
    const r = await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher);
    expect(r).toMatchObject({ enviadas: 2, reagendadas: 1 });
    const porComentario = Object.fromEntries(banco.t("meta_social_fila_de_envio").map((l) => [l.comment_id, l]));
    expect(porComentario["C-600"]).toMatchObject({ status: "enviada" });
    expect(porComentario["C-601"]).toMatchObject({ status: "na_fila", tentativas: 0 });
    // Volta quando a mais velha da janela fizer 60 minutos.
    expect(porComentario["C-601"]!.proxima_tentativa_em).toBe(new Date(AGORA.getTime() + 10 * 60_000).toISOString());
    expect(porComentario["C-B"]).toMatchObject({ status: "enviada" });
    expect(meta.chamadas.map((c) => c.url)).toEqual([
      "https://graph.facebook.com/v26.0/PAG-1/messages",
      "https://graph.facebook.com/v26.0/PAG-2/messages",
    ]);
  });

  it("limite da Meta (código 613) reagenda com espera e não é falha", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1", { resposta_privada_status: "na_fila" }), comentario("C-2", { resposta_privada_status: "na_fila" })],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada"), naFila("C-2", "resposta_privada")],
    });
    const meta = metaFalsa(() => ({ status: 400, corpo: { error: { code: 613, message: "Calls to this api have exceeded the rate limit." } } }));
    const r = await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher);
    expect(r).toMatchObject({ enviadas: 0, falharam: 0, reagendadas: 2 });
    // Só a primeira chegou à Meta: a conta parou nesta rodada.
    expect(meta.chamadas).toHaveLength(1);
    for (const l of banco.t("meta_social_fila_de_envio")) {
      expect(l.status).toBe("na_fila");
      expect(Date.parse(l.proxima_tentativa_em as string)).toBeGreaterThan(AGORA.getTime());
    }
    expect(banco.t("meta_social_comentarios").map((c) => c.resposta_privada_status)).toEqual(["na_fila", "na_fila"]);
  });

  it("HTTP 429 também é limite", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    const meta = metaFalsa(() => ({ status: 429, corpo: {} }));
    expect(await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher)).toMatchObject({ reagendadas: 1, falharam: 0 });
  });

  it("erro 2534025 vira expirada", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1", { resposta_privada_status: "na_fila" })],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    const meta = metaFalsa(() => ({ status: 400, corpo: { error: { code: 2534025, message: "not eligible" } } }));
    expect(await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher)).toMatchObject({ expiradas: 1 });
    expect(banco.t("meta_social_fila_de_envio")[0]!.status).toBe("expirada");
    expect(banco.t("meta_social_comentarios")[0]!.resposta_privada_status).toBe("expirada");
  });

  it("comentário que fez 7 dias na fila vira expirada sem chamar a Meta", async () => {
    const velho = new Date(AGORA.getTime() - 7 * 24 * 3600_000).toISOString();
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1", { criado_na_meta_em: velho, recebido_em: velho, resposta_privada_status: "na_fila" })],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    const meta = okMeta();
    expect(await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher)).toMatchObject({ expiradas: 1 });
    expect(meta.chamadas).toHaveLength(0);
  });

  it("token recusado (190): sessão marcada para reconectar, a linha espera e não falha", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_privada")],
    });
    const meta = metaFalsa(() => ({ status: 401, corpo: { error: { code: 190, message: "Invalid OAuth access token" } } }));
    expect(await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher)).toMatchObject({ reagendadas: 1, falharam: 0 });
    expect(banco.t("channel_sessions")[0]).toMatchObject({ status: "FAILED", status_reason: "token_invalido" });
    expect(banco.t("meta_social_fila_de_envio")[0]!.status).toBe("na_fila");
  });
});

describe("fila: ordem e envio único", () => {
  it("a pública espera a privada do mesmo comentário; sai depois que a privada saiu", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1", { resposta_privada_status: "na_fila" })],
      meta_social_fila_de_envio: [
        // A pública foi pedida ANTES, e a privada está adiada pela Meta.
        naFila("C-1", "resposta_publica", { criado_em: "2026-11-03T11:00:00.000Z" }),
        naFila("C-1", "resposta_privada", {
          criado_em: "2026-11-03T11:00:01.000Z",
          proxima_tentativa_em: new Date(AGORA.getTime() + 5 * 60_000).toISOString(),
        }),
      ],
    });
    const meta = okMeta();
    const r1 = await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher);
    expect(r1).toMatchObject({ enviadas: 0, aguardando: 1 });
    expect(meta.chamadas).toHaveLength(0);

    // Seis minutos depois: a privada sai primeiro, e a pública na mesma rodada.
    const depois = new Date(AGORA.getTime() + 6 * 60_000);
    const r2 = await processarFilaMetaSocial(banco.db, depois, meta.fetcher);
    expect(r2).toMatchObject({ enviadas: 2 });
    expect(meta.chamadas.map((c) => c.url)).toEqual([
      "https://graph.facebook.com/v26.0/PAG-1/messages",
      "https://graph.facebook.com/v26.0/C-1/replies",
    ]);
    expect(new URLSearchParams(meta.chamadas[1]!.body).get("message")).toBe("Olha o Direct 😉");
    expect(banco.t("meta_social_comentarios")[0]).toMatchObject({ resposta_publica_id: "reply-1" });
  });

  it("sem privada pedida, a pública sai direto", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1")],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_publica")],
    });
    const meta = okMeta();
    expect(await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher)).toMatchObject({ enviadas: 1 });
    expect(meta.chamadas[0]!.url).toBe("https://graph.facebook.com/v26.0/C-1/replies");
  });

  it("linha `enviando` (outra rodada) não é reenviada; travada há mais de 10 min vira falhou sem confirmação", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1", { resposta_privada_status: "na_fila" }), comentario("C-2", { resposta_privada_status: "na_fila" })],
      meta_social_fila_de_envio: [
        naFila("C-1", "resposta_privada", { status: "enviando", atualizado_em: new Date(AGORA.getTime() - 60_000).toISOString() }),
        naFila("C-2", "resposta_privada", { status: "enviando", atualizado_em: new Date(AGORA.getTime() - 11 * 60_000).toISOString() }),
      ],
    });
    const meta = okMeta();
    const r = await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher);
    expect(meta.chamadas).toHaveLength(0);
    expect(r).toMatchObject({ enviadas: 0, destravadas: 1 });
    const porComentario = Object.fromEntries(banco.t("meta_social_fila_de_envio").map((l) => [l.comment_id, l.status]));
    expect(porComentario).toEqual({ "C-1": "enviando", "C-2": "falhou" });
  });
});

describe("cron meta-social-fila", () => {
  it("só audita quando houve efeito", async () => {
    const { GET } = await import("@/app/api/v1/cron/meta-social-fila/route");
    h.db = bancoFalso({ channel_sessions: [sessaoA] }).db;
    const vazio = await GET(new Request("https://crm.test/api/v1/cron/meta-social-fila") as never);
    expect(vazio.status).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", okMeta().fetcher);
    h.db = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario("C-1", { recebido_em: new Date().toISOString(), criado_na_meta_em: new Date().toISOString() })],
      meta_social_fila_de_envio: [naFila("C-1", "resposta_publica", { proxima_tentativa_em: new Date(Date.now() - 1000).toISOString() })],
    }).db;
    await GET(new Request("https://crm.test/api/v1/cron/meta-social-fila") as never);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.meta_social_fila_processada" }));
  });
});
