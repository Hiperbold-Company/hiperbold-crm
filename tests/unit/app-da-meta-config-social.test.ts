/**
 * /admin/meta: id do app da Meta e `config_id` do login unificado do Instagram
 * (canal social, 0984 e 0988). Só admin de plataforma (full), trilha com os
 * campos e o memo da configuração do canal social invalidado ao salvar. O app
 * próprio do Instagram (id + chave) não é mais aceito.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USUARIO = "11111111-1111-4111-8111-111111111111";
const gravacoes: Record<string, unknown>[] = [];
const h = vi.hoisted(() => ({ portao: vi.fn(), invalidar: vi.fn() }));

// A ação passou ao portão do upstream (`escritaDeAdminOuRecusa`, que exige escopo full):
// o dublê segue o `h.portao` — o que ele resolve é o contexto, o que ele rejeita sobe.
vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({
  escritaDeAdminOuRecusa: async () => ({ ok: true, ctx: await h.portao() }),
}));
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
  it("grava o id do app e o config_id, invalida o memo e audita os campos", async () => {
    const r = await updateAppSocialDaMeta({ app_id: "1234567890", unified_config_id: "1855366338969369" });
    expect(r).toEqual({ ok: true });
    expect(gravacoes[0]).toMatchObject({
      id: 1,
      app_id: "1234567890",
      unified_config_id: "1855366338969369",
      updated_by: USUARIO,
    });
    expect(gravacoes[0]).not.toHaveProperty("instagram_app_id");
    expect(gravacoes[0]).not.toHaveProperty("instagram_app_secret_encrypted");
    expect(h.invalidar).toHaveBeenCalled();
    expect(audit.mock.calls[0]![0]).toMatchObject({
      action: "platform_meta_app.updated",
      metadata: { campos: ["app_id", "unified_config_id"] },
    });
  });

  it("campo vazio mantém o gravado: config_id em branco não apaga o salvo", async () => {
    await updateAppSocialDaMeta({ app_id: "1234567890", unified_config_id: "" });
    expect(gravacoes[0]).not.toHaveProperty("unified_config_id");
  });

  it("o app próprio do Instagram não é mais gravado, nem se vier no corpo", async () => {
    await updateAppSocialDaMeta({ app_id: "1234567890", instagram_app_secret: "abcdef0123456789abcdef" } as never);
    expect(gravacoes[0]).not.toHaveProperty("instagram_app_secret_encrypted");
    expect(gravacoes[0]).not.toHaveProperty("instagram_app_secret");
  });

  it("nada preenchido: nada_para_salvar; id ou config_id com letra: invalid_input", async () => {
    expect(await updateAppSocialDaMeta({})).toEqual({ ok: false, error: "nada_para_salvar" });
    expect((await updateAppSocialDaMeta({ app_id: "abc123" })).ok).toBe(false);
    expect((await updateAppSocialDaMeta({ unified_config_id: "config-1" })).ok).toBe(false);
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
