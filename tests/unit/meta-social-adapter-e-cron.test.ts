import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

const h = vi.hoisted(() => ({ db: null as unknown, audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));

import { metaSocialAdapter } from "@/lib/channels/meta-social/adapter";
import { dividirTexto, montarEnvios } from "@/lib/channels/meta-social/oauth";
import { marcarTokensPertoDeVencer } from "@/lib/channels/meta-social/renovacao";
import { lerSignedRequest } from "@/lib/channels/meta-social/exclusao";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessao = {
  id: "s1",
  organization_id: ORG,
  provider: "meta_social",
  meta_social_platform: "instagram",
  meta_social_account_id: "IG-A",
  meta_social_token_encrypted: "cifrado:TOKEN-SECRETO",
  archived_at: null,
};

beforeEach(() => {
  h.audit.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("montagem do envio", () => {
  it("texto no Instagram (login unificado): graph.facebook.com/<IG_ID>/messages, sem token na URL", () => {
    const [r] = montarEnvios({ plataforma: "instagram", contaId: "IG-A", destinatario: "IGSID", texto: "oi", teto: 1000 });
    expect(r!.url).toBe("https://graph.facebook.com/v26.0/IG-A/messages");
    expect(r!.corpo).toEqual({ recipient: { id: "IGSID" }, message: { text: "oi" } });
  });

  it("Instagram conectado pela Página: /<PAGE_ID>/messages, IGSID no recipient, sem messaging_type", () => {
    const envios = montarEnvios({
      plataforma: "instagram",
      contaId: "17841400000000001",
      paginaId: "PAG-9",
      destinatario: "IGSID",
      imagemUrl: "https://cdn.exemplo/a.jpg",
      texto: "oi",
      teto: 1000,
    });
    expect(envios.map((e) => e.url)).toEqual([
      "https://graph.facebook.com/v26.0/PAG-9/messages",
      "https://graph.facebook.com/v26.0/PAG-9/messages",
    ]);
    expect(envios[1]!.corpo).toEqual({ recipient: { id: "IGSID" }, message: { text: "oi" } });
    // Sem Página (ou null), o caminho de antes: a própria conta do Instagram.
    const [semPagina] = montarEnvios({
      plataforma: "instagram",
      contaId: "17841400000000001",
      paginaId: null,
      destinatario: "IGSID",
      texto: "oi",
      teto: 1000,
    });
    expect(semPagina!.url).toBe("https://graph.facebook.com/v26.0/17841400000000001/messages");
  });

  it("Messenger leva messaging_type RESPONSE; imagem vai como attachment", () => {
    const envios = montarEnvios({
      plataforma: "messenger",
      contaId: "PAG",
      destinatario: "PSID",
      imagemUrl: "https://cdn.exemplo/a.jpg",
      texto: "legenda",
      teto: 2000,
    });
    expect(envios[0]!.corpo).toEqual({
      recipient: { id: "PSID" },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "image", payload: { url: "https://cdn.exemplo/a.jpg" } } },
    });
    expect(envios[1]!.corpo).toMatchObject({ message: { text: "legenda" } });
  });

  it("texto acima do teto vira pedaços dentro do limite de bytes", () => {
    const texto = "ação ".repeat(400);
    const pedacos = dividirTexto(texto, 1000);
    expect(pedacos.length).toBeGreaterThan(1);
    for (const p of pedacos) expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(1000);
    expect(pedacos.join(" ").replace(/\s+/g, " ")).toBe(texto.trim().replace(/\s+/g, " "));
  });
});

describe("adapter.send", () => {
  it("manda com Bearer no header, nunca na URL, ao cliente da conversa", async () => {
    h.db = bancoFalso({ channel_sessions: [sessao] }).db;
    const fetchFalso = vi.fn(async () => new Response(JSON.stringify({ message_id: "mid.out" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFalso);
    const r = await metaSocialAdapter.send({
      organizationId: ORG,
      sessionRef: "IG-A",
      to: "provider-thread",
      kind: "text",
      body: "olá",
      providerConversationId: "IGSID-1",
    });
    expect(r.externalId).toBe("mid.out");
    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("TOKEN-SECRETO");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN-SECRETO");
    expect(JSON.parse(String(init.body))).toEqual({ recipient: { id: "IGSID-1" }, message: { text: "olá" } });
  });

  it("conta do Instagram com Página: envia à Página com o token guardado (o da Página)", async () => {
    h.db = bancoFalso({
      channel_sessions: [{ ...sessao, meta_social_page_id: "PAG-9", meta_social_token_encrypted: "cifrado:TOKEN-DA-PAGINA" }],
    }).db;
    const fetchFalso = vi.fn(async () => new Response(JSON.stringify({ message_id: "mid.pg" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFalso);
    const r = await metaSocialAdapter.send({
      organizationId: ORG,
      sessionRef: "IG-A",
      to: "provider-thread",
      kind: "text",
      body: "olá",
      providerConversationId: "IGSID-1",
    });
    expect(r.externalId).toBe("mid.pg");
    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v26.0/PAG-9/messages");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN-DA-PAGINA");
  });

  const enviarCom = async (resposta: unknown, status: number) => {
    const banco = bancoFalso({ channel_sessions: [{ ...sessao, status: "WORKING", status_reason: null }] });
    h.db = banco.db;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(resposta), { status })));
    const erro = await metaSocialAdapter
      .send({ organizationId: ORG, sessionRef: "IG-A", to: "provider-thread", kind: "text", body: "x", providerConversationId: "IGSID-1" })
      .catch((e: unknown) => e as Error);
    return { erro: erro as Error, sessao: banco.t("channel_sessions")[0]! };
  };

  it("token recusado (190): frase de reconectar e a sessão passa a pedir Reconectar", async () => {
    const { erro, sessao: s } = await enviarCom({ error: { code: 190, message: "Error validating access token" } }, 400);
    expect(erro.message).toMatch(/Reconecte/);
    expect(s).toMatchObject({ status: "FAILED", status_reason: "token_invalido" });
    const saude = await metaSocialAdapter.checkHealth!({ organizationId: ORG, sessionRef: "IG-A" } as never);
    expect(saude).toMatchObject({ status: "FAILED", detail: "token_invalido" });
  });

  it("(#200) acesso às mensagens desligado e (#10) conta não profissional têm frase própria", async () => {
    const a = await enviarCom(
      { error: { code: 200, message: "The account owner has disabled access to Instagram Direct Messaging" } },
      403,
    );
    expect(a.erro.message).toMatch(/Permitir acesso às mensagens/);
    expect(a.sessao).toMatchObject({ status: "WORKING" });
    const b = await enviarCom(
      { error: { code: 10, message: "Access is denied because the instagram account type is not business or creator" } },
      403,
    );
    expect(b.erro.message).toMatch(/profissional/);
    const c = await enviarCom({ error: { code: 10, message: "outside of allowed window" } }, 400);
    expect(c.erro.message).toMatch(/24 horas/);
  });

  it("conta de outra organização não envia", async () => {
    h.db = bancoFalso({ channel_sessions: [sessao] }).db;
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      metaSocialAdapter.send({
        organizationId: "outra-org",
        sessionRef: "IG-A",
        to: "provider-thread",
        kind: "text",
        body: "x",
        providerConversationId: "IGSID-1",
      }),
    ).rejects.toThrow(/Reconecte/);
  });
});

describe("validade do token do Instagram (login unificado)", () => {
  const agora = new Date("2026-11-02T06:35:00Z");
  const dia = 24 * 3600 * 1000;
  const linha = (id: string, venceEmDias: number | null, extra: Record<string, unknown> = {}) => ({
    ...sessao,
    id,
    meta_social_account_id: id,
    status: "WORKING",
    status_reason: null,
    meta_social_token_expires_at:
      venceEmDias === null ? null : new Date(agora.getTime() + venceEmDias * dia).toISOString(),
    meta_social_token_refreshed_at: new Date(agora.getTime() - 50 * dia).toISOString(),
    metadata: {},
    ...extra,
  });

  it("sem validade não faz nada; vence em até 7 dias pede reconectar; nunca renova", async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal("fetch", fetchFalso);
    const banco = bancoFalso({
      channel_sessions: [
        linha("sem-validade", null),
        linha("longe", 30),
        linha("perto", 5),
        linha("ja-marcada", 3, { status: "FAILED", status_reason: "token_vence_em_breve" }),
      ],
    });
    const r = await marcarTokensPertoDeVencer(banco.db, agora);
    expect(r).toEqual({ examinadas: 1, marcadas: 1 });
    const porId = Object.fromEntries(banco.t("channel_sessions").map((l) => [l.id, l]));
    expect(porId.perto).toMatchObject({ status: "FAILED", status_reason: "token_vence_em_breve" });
    expect(porId["sem-validade"]).toMatchObject({ status: "WORKING", status_reason: null });
    expect(porId.longe).toMatchObject({ status: "WORKING", status_reason: null });
    // O token não muda: não há renovação automática.
    expect(porId.perto!.meta_social_token_encrypted).toBe("cifrado:TOKEN-SECRETO");
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("a sessão marcada aparece como FAILED na saúde (o vigia abre o aviso)", async () => {
    h.db = bancoFalso({
      channel_sessions: [linha("IG-A", 5, { status: "FAILED", status_reason: "token_vence_em_breve" })],
    }).db;
    const saude = await metaSocialAdapter.checkHealth!({ organizationId: ORG, sessionRef: "IG-A" } as never);
    expect(saude).toMatchObject({ status: "FAILED", detail: "token_vence_em_breve" });
  });

  it("o cron só audita quando houve efeito", async () => {
    const { GET } = await import("@/app/api/v1/cron/meta-social-tokens/route");
    h.db = bancoFalso({ channel_sessions: [linha("longe", 30), linha("sem-validade", null)] }).db;
    await GET(new Request("https://crm.test/api/v1/cron/meta-social-tokens") as never);
    expect(h.audit).not.toHaveBeenCalled();

    h.db = bancoFalso({ channel_sessions: [linha("perto", 5)] }).db;
    await GET(new Request("https://crm.test/api/v1/cron/meta-social-tokens") as never);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });
});

describe("signed_request da exclusão de dados", () => {
  const assinar = (carga: object, segredo: string) => {
    const c = Buffer.from(JSON.stringify(carga)).toString("base64url");
    return `${createHmac("sha256", segredo).update(c).digest("base64url")}.${c}`;
  };
  it("confere com qualquer segredo e diz qual", () => {
    const s = assinar({ algorithm: "HMAC-SHA256", user_id: "123", issued_at: 1_762_000_000 }, "ig");
    expect(lerSignedRequest(s, ["meta", "ig"], new Date(1_762_000_000_000 + 60_000))).toMatchObject({
      userId: "123",
      segredo: 1,
    });
  });
  it("recusa assinatura alheia e carga sem user_id", () => {
    expect(lerSignedRequest(assinar({ user_id: "1" }, "outro"), ["meta"])).toBeNull();
    expect(lerSignedRequest(assinar({ algorithm: "HMAC-SHA256" }, "meta"), ["meta"])).toBeNull();
    expect(lerSignedRequest("lixo", ["meta"])).toBeNull();
  });
});
