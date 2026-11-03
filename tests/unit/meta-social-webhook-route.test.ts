import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

process.env.META_APP_SECRET = "segredo-do-app";
process.env.META_WEBHOOK_VERIFY_TOKEN = "token-de-verificacao";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn(async () => undefined) }));
vi.mock("@/lib/plataformas-de-anuncio/google/atribuicao", () => ({
  extrairEEstamparAtribuicaoGoogle: vi.fn(async () => undefined),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/v1/webhooks/meta-social/route";
import { invalidarAppDaMeta } from "@/lib/channels/meta/app";
import { invalidarConfigMetaSocial } from "@/lib/channels/meta-social/config";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const corpo = (conta: string) =>
  JSON.stringify({
    object: "instagram",
    organization_id: ORG_B,
    entry: [
      {
        id: conta,
        messaging: [
          { sender: { id: "IGSID" }, recipient: { id: conta }, timestamp: 1, message: { mid: `mid-${conta}`, text: "oi" } },
        ],
      },
    ],
  });
const post = (texto: string, segredo = "segredo-do-app") =>
  POST(
    new NextRequest("https://crm.exemplo/api/v1/webhooks/meta-social", {
      method: "POST",
      body: texto,
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", segredo).update(texto).digest("hex")}` },
    }),
  );

beforeEach(() => {
  invalidarAppDaMeta();
  invalidarConfigMetaSocial();
});

describe("webhook social", () => {
  it("handshake responde o challenge em texto puro", async () => {
    h.db = bancoFalso().db;
    const res = await GET(
      new NextRequest(
        "https://crm.exemplo/api/v1/webhooks/meta-social?hub.mode=subscribe&hub.verify_token=token-de-verificacao&hub.challenge=777",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("777");
  });

  it("assinatura errada é 401 e nada é gravado", async () => {
    const banco = bancoFalso();
    h.db = banco.db;
    expect((await post(corpo("IG-A"), "outro")).status).toBe(401);
    expect(banco.t("messages")).toHaveLength(0);
  });

  it("a organização vem da sessão do entry.id, nunca de campo do corpo; conta desconhecida é 200 ignorado", async () => {
    const banco = bancoFalso({
      channel_sessions: [
        {
          id: "sessao-a",
          organization_id: ORG_A,
          provider: "meta_social",
          meta_social_platform: "instagram",
          meta_social_account_id: "IG-A",
          meta_social_token_encrypted: null,
          archived_at: null,
        },
      ],
    });
    h.db = banco.db;
    const r1 = await post(corpo("IG-A"));
    expect(r1.status).toBe(200);
    expect(banco.t("messages")).toHaveLength(1);
    expect(banco.t("messages")[0]!.organization_id).toBe(ORG_A);

    const r2 = await post(corpo("IG-DESCONHECIDA"));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ outcomes: ["ignored:conta_desconhecida"] });
    expect(banco.t("messages")).toHaveLength(1);
  });
});
