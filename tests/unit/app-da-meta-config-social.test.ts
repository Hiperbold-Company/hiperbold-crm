/**
 * /admin/meta: ids dos apps e chave do app do Instagram (canal social, 0984).
 * Só admin de plataforma (full), chave cifrada e nunca devolvida, trilha sem
 * valor, e o memo da configuração do canal social invalidado ao salvar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USUARIO = "11111111-1111-4111-8111-111111111111";
const CHAVE_IG = "abcdef0123456789abcdef0123456789";
const gravacoes: Record<string, unknown>[] = [];
const h = vi.hoisted(() => ({ portao: vi.fn(), invalidar: vi.fn() }));

vi.mock("@/lib/auth/portao-de-escrita", () => ({ requirePlatformAdminFull: h.portao }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/channels/meta-social/config", () => ({ invalidarConfigMetaSocial: h.invalidar }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      upsert: async (v: Record<string, unknown>) => {
        gravacoes.push(v);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async (_a: unknown, v: string) => `cifra(${v})` }));
const audit = vi.fn(async (_e: Record<string, unknown>) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (e: Record<string, unknown>) => audit(e) }));

import { updateAppSocialDaMeta } from "@/app/actions/settings/updateMetaApp";
import { enderecosParaAMeta } from "@/lib/channels/meta-social/enderecos";

beforeEach(() => {
  gravacoes.length = 0;
  audit.mockClear();
  h.invalidar.mockClear();
  h.portao.mockReset();
  h.portao.mockResolvedValue({ user: { id: USUARIO } });
});

describe("updateAppSocialDaMeta", () => {
  it("grava os ids e a chave cifrada, invalida o memo e audita sem valor", async () => {
    const r = await updateAppSocialDaMeta({ app_id: "1234567890", instagram_app_id: "987654321", instagram_app_secret: CHAVE_IG });
    expect(r).toEqual({ ok: true });
    expect(gravacoes[0]).toMatchObject({
      id: 1,
      app_id: "1234567890",
      instagram_app_id: "987654321",
      instagram_app_secret_encrypted: `cifra(${CHAVE_IG})`,
      updated_by: USUARIO,
    });
    expect(h.invalidar).toHaveBeenCalled();
    const trilha = JSON.stringify(audit.mock.calls);
    expect(trilha).not.toContain(CHAVE_IG);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      action: "platform_meta_app.updated",
      metadata: { campos: ["app_id", "instagram_app_id", "instagram_app_secret_encrypted"] },
    });
  });

  it("campo vazio mantém o gravado: a chave em branco não apaga a salva", async () => {
    await updateAppSocialDaMeta({ app_id: "1234567890", instagram_app_secret: "" });
    expect(gravacoes[0]).not.toHaveProperty("instagram_app_secret_encrypted");
    expect(gravacoes[0]).not.toHaveProperty("instagram_app_id");
  });

  it("nada preenchido: nada_para_salvar; id com letra ou chave curta: invalid_input", async () => {
    expect(await updateAppSocialDaMeta({})).toEqual({ ok: false, error: "nada_para_salvar" });
    expect((await updateAppSocialDaMeta({ app_id: "abc123" })).ok).toBe(false);
    expect((await updateAppSocialDaMeta({ instagram_app_secret: "curta" })).ok).toBe(false);
    expect(gravacoes).toEqual([]);
  });

  it("quem não é admin de plataforma (full) não grava", async () => {
    h.portao.mockRejectedValue(new Error("forbidden"));
    await expect(updateAppSocialDaMeta({ app_id: "1234567890" })).rejects.toThrow();
    expect(gravacoes).toEqual([]);
  });
});

describe("endereços que o dono cadastra na Meta", () => {
  it("são os caminhos das rotas reais", () => {
    expect(enderecosParaAMeta("https://crm.ex").map((e) => e.url)).toEqual([
      "https://crm.ex/api/v1/webhooks/meta-social",
      "https://crm.ex/api/v1/channels/meta-social/callback/instagram",
      "https://crm.ex/api/v1/channels/meta-social/callback/messenger",
      "https://crm.ex/api/v1/meta/exclusao-de-dados",
      "https://crm.ex/legal/privacy",
    ]);
  });
});
