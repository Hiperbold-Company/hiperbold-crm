/**
 * O aceite dos Termos dado no cadastro vai para `organizations.onboarding_state.welcome` quando a empresa nasce,
 * mas só com a compra pelo cliente ligada (o wizard completo continua pedindo tudo nas demais instalações), e só
 * se o aceite estiver no `app_metadata` (que a pessoa não escreve), nunca no `user_metadata`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const insertsEmOrganizations: Array<Record<string, unknown>> = [];
const compra = vi.hoisted(() => ({ ligada: true }));

function tabela(nome: string) {
  if (nome === "organizations") {
    return {
      insert: (linha: Record<string, unknown>) => {
        insertsEmOrganizations.push(linha);
        return { select: () => ({ single: async () => ({ data: { id: "org-nova", slug: linha.slug }, error: null }) }) };
      },
    };
  }
  return {
    insert: async () => ({ error: null }),
    select: () => ({
      eq: () => ({
        is: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
  };
}

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/conta-e-cobranca/boas-vindas", () => ({ avisarBoasVindas: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: tabela }) }));
// A pergunta "a compra pelo cliente está ligada?" depende de env do Asaas e de `billing_settings`.
vi.mock("@/lib/onboarding/precisa-pagar", () => ({
  compraPeloClienteDisponivel: vi.fn(async () => compra.ligada),
}));

const ACEITE = { versao: "2026-10-14", aceito_em: "2026-10-15T12:00:00.000Z" };

beforeEach(() => {
  insertsEmOrganizations.length = 0;
  compra.ligada = true;
});

describe("aceite do cadastro → onboarding_state.welcome", () => {
  it("compra ligada + aceite no app_metadata: a empresa nasce com o passo 'welcome' cumprido", async () => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await ensureTenantForUser({
      id: "user-1",
      email: "pessoa@exemplo.com",
      user_metadata: { org_name: "Empresa X" },
      app_metadata: { aceite_termos: ACEITE },
    });

    expect(insertsEmOrganizations).toHaveLength(1);
    expect(insertsEmOrganizations[0]?.onboarding_state).toEqual({
      welcome: {
        accepted_at: ACEITE.aceito_em,
        terms_version: ACEITE.versao,
        timezone: "America/Sao_Paulo",
        display_name: "Empresa X",
      },
    });
    expect(insertsEmOrganizations[0]?.settings).toEqual({ billing_inicio: "sem_plano" });
  });

  it("compra desligada: nada muda, o wizard completo segue pedindo o aceite", async () => {
    compra.ligada = false;
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await ensureTenantForUser({
      id: "user-1",
      user_metadata: { org_name: "Empresa X" },
      app_metadata: { aceite_termos: ACEITE },
    });
    expect(insertsEmOrganizations[0]).not.toHaveProperty("onboarding_state");
  });

  it("sem aceite (Google, convite, conta antiga): nada é inventado", async () => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await ensureTenantForUser({ id: "user-1", email: "a@b.test", user_metadata: { org_name: "Empresa X" }, app_metadata: {} });
    expect(insertsEmOrganizations[0]).not.toHaveProperty("onboarding_state");
  });

  it("aceite escrito no user_metadata (que a própria pessoa edita) é ignorado", async () => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await ensureTenantForUser({
      id: "user-1",
      email: "a@b.test",
      user_metadata: { org_name: "Empresa X", aceite_termos: ACEITE },
      app_metadata: {},
    });
    expect(insertsEmOrganizations[0]).not.toHaveProperty("onboarding_state");
  });

  it.each([
    ["sem versão", { aceito_em: ACEITE.aceito_em }],
    ["data inválida", { versao: "v", aceito_em: "ontem" }],
    ["tipo errado", "sim"],
  ])("aceite mal formado (%s) não vale", async (_nome, aceite) => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await ensureTenantForUser({
      id: "user-1",
      email: "a@b.test",
      user_metadata: { org_name: "Empresa X" },
      app_metadata: { aceite_termos: aceite },
    });
    expect(insertsEmOrganizations[0]).not.toHaveProperty("onboarding_state");
  });
});
