/**
 * O CLIENTE NOVO PAGA ANTES DE CONFIGURAR (decisão do dono do produto, 15/10/2026).
 *
 * Mede o COMPORTAMENTO de quatro peças, com o código real de cada uma e dublê só nas bordas
 * (ambiente, sessão e banco no formato do PostgREST):
 *
 *  1. `precisaPagarAntesDeConfigurar`: quando o passo "Plano" existe. Tem de concordar com a guarda
 *     de `app/app/layout.tsx` (`organizacaoSemPlano`) — a pergunta "esta organização está sem
 *     plano?" não pode ter duas respostas.
 *  2. `exigirPlanoPagoParaSeguir`: a guarda de PÁGINA dos passos depois do pagamento.
 *  3. `requireOnboardingCtx`: a guarda das SERVER ACTIONS (o id delas está no bundle).
 *  4. `contextoDoOnboarding`: o que alimenta o roteador, o indicador e o resumo.
 *
 * Comando: npx vitest run tests/unit/onboarding-plano-precisa-pagar.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const ONTEM = new Date(Date.now() - 86_400_000).toISOString();
const AMANHA = new Date(Date.now() + 86_400_000).toISOString();

interface Contrato {
  status: string;
  cycle: string | null;
  current_period_end: string | null;
  bloqueio_a_partir_de: string | null;
}

const h = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NUVEMSHOP_ENABLED: false,
    ASAAS_ENABLED: true,
    ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
    ASAAS_API_KEY: "$aact_hmlg_teste",
    ASAAS_WEBHOOK_TOKEN: "",
    ASAAS_WEBHOOK_ID: "",
  } as Record<string, unknown>,
  settings: { modo: "bloquear", compra_pelo_cliente: true } as Record<string, unknown> | null,
  settingsErro: false,
  /** `organizations.settings`: o cadastro do próprio visitante grava o marcador `billing_inicio`. */
  settingsDaOrg: { billing_inicio: "sem_plano" } as Record<string, unknown>,
  contratoErro: false,
  contrato: null as Contrato | null,
  onboardedAt: null as string | null,
  papel: "admin",
  redirecionou: [] as string[],
}));

vi.mock("@/lib/env", () => ({ env: h.env }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    h.redirecionou.push(destino);
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, email: "dono@qa.local", full_name: "Dono" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "QA", role: h.papel })),
  mfaEmDivida: vi.fn(async () => false),
}));

/** Banco no formato do PostgREST: cada `createAdminClient()` é um cliente novo (o cache do modo é por cliente). */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const resolver = () => {
        if (tabela === "billing_settings") {
          return h.settingsErro
            ? { data: null, error: { message: "boom" } }
            : { data: h.settings, error: null };
        }
        if (tabela === "billing_contracts") {
          return h.contratoErro ? { data: null, error: { message: "boom" } } : { data: h.contrato, error: null };
        }
        if (tabela === "organizations") {
          return {
            data: { onboarding_state: {}, onboarded_at: h.onboardedAt, settings: h.settingsDaOrg },
            error: null,
          };
        }
        throw new Error(`tabela não dublada: ${tabela}`);
      };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => resolver();
      b.single = async () => resolver();
      return b;
    },
  }),
}));

import { requireOnboardingCtx, OnboardingError } from "@/app/actions/onboarding/_shared";
import { organizacaoSemPlano } from "@/lib/billing/assinatura/sem-plano";
import { contextoDoOnboarding, contextoDoOnboardingComLeitura, exigirPlanoPagoParaSeguir } from "@/lib/onboarding/contexto";
import { precisaPagarAntesDeConfigurar, situacaoDoPagamento } from "@/lib/onboarding/precisa-pagar";
import { createAdminClient } from "@/lib/supabase/admin";

/** O contrato que `fn_billing_contrato_da_organizacao_nova` (0940) grava para o cadastro do próprio visitante. */
const SEM_PLANO: Contrato = { status: "suspensa", cycle: null, current_period_end: null, bloqueio_a_partir_de: ONTEM };

beforeEach(() => {
  h.env.NUVEMSHOP_ENABLED = false;
  h.env.ASAAS_ENABLED = true;
  h.env.ASAAS_BASE_URL = "https://api-sandbox.asaas.com/v3";
  h.env.ASAAS_API_KEY = "$aact_hmlg_teste";
  h.settings = { modo: "bloquear", compra_pelo_cliente: true };
  h.settingsErro = false;
  h.settingsDaOrg = { billing_inicio: "sem_plano" };
  h.contratoErro = false;
  h.contrato = SEM_PLANO;
  h.onboardedAt = null;
  h.papel = "admin";
  h.redirecionou.length = 0;
});

async function precisa(): Promise<boolean> {
  return precisaPagarAntesDeConfigurar(createAdminClient(), ORG);
}

describe("precisaPagarAntesDeConfigurar: quando o passo 'Plano' existe", () => {
  it("cadastro do próprio visitante (suspenso, sem período, sem ciclo) com a compra ligada: precisa pagar", async () => {
    expect(await precisa()).toBe(true);
  });

  it("contrato ativo (já pagou): segue direto", async () => {
    h.contrato = { status: "ativa", cycle: "monthly", current_period_end: AMANHA, bloqueio_a_partir_de: null };
    expect(await precisa()).toBe(false);
  });

  it("plano liberado pelo admin da plataforma (Ilimitado, sem o marcador de 'sem plano'): segue direto", async () => {
    h.contrato = { status: "ativa", cycle: null, current_period_end: null, bloqueio_a_partir_de: null };
    expect(await precisa()).toBe(false);
    h.contrato = null; // organização anterior ao gatilho: Ilimitado por omissão
    expect(await precisa()).toBe(false);
  });

  it("suspensão por falta de pagamento (tem período) não é 'sem plano': não manda para o passo", async () => {
    h.contrato = { status: "suspensa", cycle: "monthly", current_period_end: ONTEM, bloqueio_a_partir_de: ONTEM };
    expect(await precisa()).toBe(false);
  });

  it("conta recém-criada (bloqueio ainda adiante, a carência de 5 s da criação) já precisa pagar: senão o 'paga primeiro' conclui o onboarding sem pagar", async () => {
    h.contrato = { ...SEM_PLANO, bloqueio_a_partir_de: AMANHA };
    expect(await precisa()).toBe(true);
  });

  it("⭐ o modo de cobrança NÃO decide: com a compra ligada, quem nunca assinou paga em avisar, desligado e bloquear", async () => {
    for (const modo of ["avisar", "desligado", "bloquear"]) {
      h.settings = { modo, compra_pelo_cliente: true };
      expect(await precisa()).toBe(true);
    }
  });

  it("⭐ sem o marcador 'sem_plano' na organização (admin da plataforma liberou / provisionamento externo): não paga", async () => {
    h.settingsDaOrg = {};
    expect(await precisa()).toBe(false);
  });

  it("compra pelo cliente DESLIGADA no banco: o passo some (não prende ninguém num passo sem como cumprir)", async () => {
    h.settings = { modo: "bloquear", compra_pelo_cliente: false };
    expect(await precisa()).toBe(false);
  });

  it("ASAAS_ENABLED desligado: o passo some, e o banco nem é consultado para a compra", async () => {
    h.env.ASAAS_ENABLED = false;
    expect(await precisa()).toBe(false);
  });

  it("configuração do Asaas incoerente (base e chave de ambientes diferentes): a compra não abre, o passo some", async () => {
    h.env.ASAAS_API_KEY = "$aact_prod_teste";
    expect(await precisa()).toBe(false);
  });

  it("leitura que falha NUNCA prende o cliente fora do wizard nas guardas (fail-open)", async () => {
    h.settingsErro = true;
    expect(await precisa()).toBe(false);
    h.settingsErro = false;
    h.contratoErro = true;
    expect(await precisa()).toBe(false);
  });

  it("⭐ situacaoDoPagamento separa 'não precisa' de 'não consegui ler' (o roteador não conclui sem saber)", async () => {
    h.contratoErro = true;
    expect(await situacaoDoPagamento(createAdminClient(), ORG)).toEqual({ precisaPagar: false, leituraFalhou: true });
    h.contratoErro = false;
    h.contrato = { status: "ativa", cycle: "monthly", current_period_end: AMANHA, bloqueio_a_partir_de: null };
    expect(await situacaoDoPagamento(createAdminClient(), ORG)).toEqual({ precisaPagar: false, leituraFalhou: false });
  });

  it("concorda com a guarda do layout de /app nos cenários em que o modo não muda a resposta (em avisar o layout ainda não cobra; o wizard cobra)", async () => {
    const cenarios: Array<[string, Contrato | null, string]> = [
      ["sem plano", SEM_PLANO, "bloquear"],
      ["ativo", { status: "ativa", cycle: "monthly", current_period_end: AMANHA, bloqueio_a_partir_de: null }, "bloquear"],
      ["sem contrato", null, "bloquear"],
      ["inadimplente", { status: "suspensa", cycle: "monthly", current_period_end: ONTEM, bloqueio_a_partir_de: ONTEM }, "bloquear"],
    ];
    for (const [, contrato, modo] of cenarios) {
      h.contrato = contrato;
      h.settings = { modo, compra_pelo_cliente: true };
      expect(await precisa()).toBe(await organizacaoSemPlano(createAdminClient(), ORG));
    }
  });
});

describe("contextoDoOnboarding: o que decide os passos", () => {
  it("leva a loja e a exigência de pagamento — a mesma resposta para roteador, indicador e resumo", async () => {
    h.env.NUVEMSHOP_ENABLED = true;
    expect(await contextoDoOnboarding(ORG)).toEqual({ lojaLigada: true, precisaPagar: true, pagarPrimeiro: true });
    h.contrato = { status: "ativa", cycle: "monthly", current_period_end: AMANHA, bloqueio_a_partir_de: null };
    expect(await contextoDoOnboarding(ORG)).toEqual({ lojaLigada: true, precisaPagar: false, pagarPrimeiro: true });
  });
});

describe("contextoDoOnboarding: o caminho 'paga primeiro' acompanha a compra pelo cliente", () => {
  it("compra desligada (ASAAS_ENABLED=false): o wizard completo, sem pagar primeiro", async () => {
    h.env.ASAAS_ENABLED = false;
    expect(await contextoDoOnboarding(ORG)).toEqual({ lojaLigada: false, precisaPagar: false, pagarPrimeiro: false });
  });

  it("⭐ compra ligada em avisar: paga-primeiro vale e a conta sem plano precisa pagar do mesmo jeito", async () => {
    h.settings = { modo: "avisar", compra_pelo_cliente: true };
    expect(await contextoDoOnboarding(ORG)).toEqual({ lojaLigada: false, precisaPagar: true, pagarPrimeiro: true });
  });

  it("leitura do contrato falhou: o contexto sinaliza (para o roteador não concluir)", async () => {
    h.contratoErro = true;
    const r = await contextoDoOnboardingComLeitura(ORG);
    expect(r.leituraFalhou).toBe(true);
    expect(r.ctx.pagarPrimeiro).toBe(true);
  });
});

describe("exigirPlanoPagoParaSeguir: digitar a URL de um passo não pula o pagamento", () => {
  it("pagamento exigido: volta para o passo Plano", async () => {
    await expect(exigirPlanoPagoParaSeguir(ORG)).rejects.toThrow("NEXT_REDIRECT:/onboarding/plano");
    expect(h.redirecionou).toEqual(["/onboarding/plano"]);
  });

  it("pagamento confirmado (contrato ativo): a página abre", async () => {
    h.contrato = { status: "ativa", cycle: "monthly", current_period_end: AMANHA, bloqueio_a_partir_de: null };
    await expect(exigirPlanoPagoParaSeguir(ORG)).resolves.toBeUndefined();
    expect(h.redirecionou).toEqual([]);
  });

  it("compra desligada: a página abre (o passo foi pulado sozinho)", async () => {
    h.settings = { modo: "bloquear", compra_pelo_cliente: false };
    await expect(exigirPlanoPagoParaSeguir(ORG)).resolves.toBeUndefined();
  });
});

describe("requireOnboardingCtx: as actions dos passos de configuração também esperam o pagamento", () => {
  async function codigo(chamada: () => Promise<unknown>): Promise<string | null> {
    try {
      await chamada();
      return null;
    } catch (err) {
      return err instanceof OnboardingError ? err.code : `outro:${String(err)}`;
    }
  }

  it("pagamento exigido: a action é recusada com payment_required", async () => {
    expect(await codigo(() => requireOnboardingCtx())).toBe("payment_required");
  });

  it("o passo 1 (acceptWelcome) vem ANTES do pagamento e passa", async () => {
    await expect(requireOnboardingCtx({ semGuardaDePlano: true })).resolves.toMatchObject({ orgId: ORG });
  });

  it("concluir o onboarding também espera o pagamento (permitirConcluido não é atalho)", async () => {
    expect(await codigo(() => requireOnboardingCtx({ permitirConcluido: true }))).toBe("payment_required");
  });

  it("pagamento confirmado: a action passa", async () => {
    h.contrato = { status: "ativa", cycle: "monthly", current_period_end: AMANHA, bloqueio_a_partir_de: null };
    await expect(requireOnboardingCtx()).resolves.toMatchObject({ orgId: ORG, role: "admin" });
  });

  it("organização já concluída segue recusada como antes (forbidden), e o segundo clique de 'concluir' passa", async () => {
    h.onboardedAt = "2026-09-01T10:00:00Z";
    expect(await codigo(() => requireOnboardingCtx())).toBe("forbidden");
    await expect(requireOnboardingCtx({ permitirConcluido: true })).resolves.toMatchObject({ orgId: ORG });
  });

  it("quem não é admin continua recusado por papel, antes de qualquer pergunta de pagamento", async () => {
    h.papel = "viewer";
    expect(await codigo(() => requireOnboardingCtx())).toBe("forbidden");
  });
});
