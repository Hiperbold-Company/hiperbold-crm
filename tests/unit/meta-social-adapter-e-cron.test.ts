import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

const h = vi.hoisted(() => ({ db: null as unknown, audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));

import { metaSocialAdapter } from "@/lib/channels/meta-social/adapter";
import { dividirTexto, montarEnvios } from "@/lib/channels/meta-social/oauth";
import { renovarTokensDoInstagram } from "@/lib/channels/meta-social/renovacao";
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
  it("texto no Instagram: /<conta>/messages, sem token na URL", () => {
    const [r] = montarEnvios({ plataforma: "instagram", contaId: "IG-A", destinatario: "IGSID", texto: "oi", teto: 1000 });
    expect(r!.url).toBe("https://graph.instagram.com/v26.0/IG-A/messages");
    expect(r!.corpo).toEqual({ recipient: { id: "IGSID" }, message: { text: "oi" } });
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

describe("renovação do token do Instagram", () => {
  const agora = new Date("2026-11-02T06:35:00Z");
  const dia = 24 * 3600 * 1000;
  const linha = (id: string, venceEmDias: number, renovadoHaDias: number) => ({
    ...sessao,
    id,
    meta_social_account_id: id,
    meta_social_token_expires_at: new Date(agora.getTime() + venceEmDias * dia).toISOString(),
    meta_social_token_refreshed_at: new Date(agora.getTime() - renovadoHaDias * dia).toISOString(),
    metadata: {},
  });

  it("renova só quem vence em menos de 20 dias e tem 24h; falha marca a sessão", async () => {
    const banco = bancoFalso({
      channel_sessions: [linha("vence", 5, 50), linha("longe", 40, 20), linha("novo", 5, 0.5), linha("falha", 3, 57)],
    });
    const renovar = vi.fn(async (token: string) => {
      if (token === "TOKEN-SECRETO" && renovar.mock.calls.length === 1) throw new Error("recusado");
      return { token: "NOVO", expiraEmSegundos: 60 * 24 * 3600 };
    });
    const r = await renovarTokensDoInstagram(banco.db, agora, renovar);
    expect(r).toEqual({ examinadas: 2, renovadas: 1, falhas: 1 });
    const porId = Object.fromEntries(banco.t("channel_sessions").map((l) => [l.id, l]));
    expect(porId.falha!.metadata).toMatchObject({ token_erro: "meta_recusou_a_renovacao" });
    expect(porId.vence!.meta_social_token_encrypted).toBe("cifrado:NOVO");
    expect(porId.longe!.meta_social_token_encrypted).toBe("cifrado:TOKEN-SECRETO");
  });

  it("o cron só audita quando houve efeito", async () => {
    const { GET } = await import("@/app/api/v1/cron/meta-social-tokens/route");
    h.db = bancoFalso({ channel_sessions: [linha("longe", 40, 20)] }).db;
    await GET(new Request("https://crm.test/api/v1/cron/meta-social-tokens") as never);
    expect(h.audit).not.toHaveBeenCalled();

    h.db = bancoFalso({ channel_sessions: [linha("vence", 5, 50)] }).db;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
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
    expect(lerSignedRequest(s, ["meta", "ig"])).toMatchObject({ userId: "123", segredo: 1 });
  });
  it("recusa assinatura alheia e carga sem user_id", () => {
    expect(lerSignedRequest(assinar({ user_id: "1" }, "outro"), ["meta"])).toBeNull();
    expect(lerSignedRequest(assinar({ algorithm: "HMAC-SHA256" }, "meta"), ["meta"])).toBeNull();
    expect(lerSignedRequest("lixo", ["meta"])).toBeNull();
  });
});
