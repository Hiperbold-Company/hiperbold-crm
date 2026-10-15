/**
 * O ROTEADOR DO WIZARD NO CAMINHO "PAGA PRIMEIRO" (compra pelo cliente ligada, 15/10/2026).
 *
 * Mede o COMPORTAMENTO da página `/onboarding` com o código real de passos, destino, contexto e
 * conclusão; dublê só nas bordas (sessão, banco no formato do PostgREST, auditoria, redirect):
 *
 *  - conta sem plano, bloqueio vencido: vai para o pagamento, sem passar por boas-vindas;
 *  - pagamento confirmado (contrato ativo): conclui o onboarding SEM tela final e entra no Início;
 *  - conta de suporte nunca conclui nada;
 *  - compra desligada: o wizard antigo, intacto (boas-vindas primeiro; tela final no fim);
 *  - quem já concluiu: a entrada de /app (compra ligada) ou o inbox (compra desligada).
 *
 * Comando: npx vitest run tests/unit/onboarding-roteador-paga-primeiro.test.ts
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

const SEM_PLANO: Contrato = { status: "suspensa", cycle: null, current_period_end: null, bloqueio_a_partir_de: ONTEM };
const ATIVO: Contrato = { status: "ativa", cycle: "monthly", current_period_end: AMANHA, bloqueio_a_partir_de: null };

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
  settings: { modo: "bloquear", compra_pelo_cliente: true } as Record<string, unknown>,
  /** `organizations.settings`: o cadastro do próprio visitante grava o marcador `billing_inicio`. */
  settingsDaOrg: { billing_inicio: "sem_plano" } as Record<string, unknown>,
  contratoErro: false,
  contrato: null as Contrato | null,
  onboardedAt: null as string | null,
  onboardingState: {} as Record<string, unknown>,
  suporte: false,
  redirecionou: [] as string[],
  atualizacoes: [] as Array<Record<string, unknown>>,
  eventos: [] as Array<Record<string, unknown>>,
  auditorias: [] as string[],
}));

vi.mock("@/lib/env", () => ({ env: h.env }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    h.redirecionou.push(destino);
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (a: { action: string }) => {
    h.auditorias.push(a.action);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({ id: USER, email: "dono@qa.local", support: h.suporte ? { organization_id: ORG } : null })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "QA", role: "admin" })),
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "limit"]) b[m] = () => b;
      const ler = () => {
        if (tabela === "billing_settings") return { data: h.settings, error: null };
        if (tabela === "billing_contracts") {
          return h.contratoErro ? { data: null, error: { message: "boom" } } : { data: h.contrato, error: null };
        }
        if (tabela === "organizations") {
          return {
            data: { onboarding_state: h.onboardingState, onboarded_at: h.onboardedAt, settings: h.settingsDaOrg },
            error: null,
          };
        }
        throw new Error(`tabela não dublada: ${tabela}`);
      };
      b.maybeSingle = async () => ler();
      b.single = async () => ler();
      let linhasAlteradas = 0;
      b.update = (valores: Record<string, unknown>) => {
        h.atualizacoes.push(valores);
        // O UPDATE condicional (`is onboarded_at null`) só altera linha enquanto ela ainda está nula.
        if (tabela === "organizations" && typeof valores.onboarded_at === "string") {
          linhasAlteradas = h.onboardedAt === null ? 1 : 0;
          h.onboardedAt = h.onboardedAt ?? valores.onboarded_at;
        }
        return b;
      };
      b.insert = async (linha: Record<string, unknown>) => {
        h.eventos.push(linha);
        return { error: null };
      };
      // `update(...).eq(...).is(...)` é aguardado: o próprio builder precisa ser thenable.
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: linhasAlteradas > 0 ? [{ id: ORG }] : [], error: null });
      return b;
    },
  }),
}));

import OnboardingIndex from "@/app/onboarding/page";

async function rotear(): Promise<string> {
  try {
    await OnboardingIndex();
  } catch (err) {
    const m = /^NEXT_REDIRECT:(.*)$/.exec(err instanceof Error ? err.message : "");
    if (m) return m[1]!;
    throw err;
  }
  throw new Error("o roteador sempre redireciona");
}

beforeEach(() => {
  h.env.ASAAS_ENABLED = true;
  h.settings = { modo: "bloquear", compra_pelo_cliente: true };
  h.contrato = SEM_PLANO;
  h.settingsDaOrg = { billing_inicio: "sem_plano" };
  h.contratoErro = false;
  h.onboardedAt = null;
  h.onboardingState = {};
  h.suporte = false;
  h.redirecionou.length = 0;
  h.atualizacoes.length = 0;
  h.eventos.length = 0;
  h.auditorias.length = 0;
});

describe("roteador com a compra ligada", () => {
  it("conta nova sem plano vai direto ao pagamento, sem boas-vindas, e nada é concluído", async () => {
    expect(await rotear()).toBe("/onboarding/plano");
    expect(h.atualizacoes).toEqual([]);
  });

  it("pagamento confirmado: conclui o onboarding sem tela final e entra no Início", async () => {
    h.contrato = ATIVO;
    expect(await rotear()).toBe("/app/inicio");
    expect(h.atualizacoes).toHaveLength(1);
    expect(typeof h.atualizacoes[0]!.onboarded_at).toBe("string");
    expect(h.eventos).toMatchObject([{ organization_id: ORG, event_type: "tenant.onboarded" }]);
    expect(h.auditorias).toEqual(["onboarding.completed", "tenant.onboarded"]);
  });

  it("depois de concluída, abrir o wizard de novo manda para a entrada de /app, sem concluir outra vez", async () => {
    h.contrato = ATIVO;
    await rotear();
    h.redirecionou.length = 0;
    h.atualizacoes.length = 0;
    expect(await rotear()).toBe("/app");
    expect(h.atualizacoes).toEqual([]);
    expect(h.eventos).toHaveLength(1);
  });

  it("⭐ modo avisar + conta sem plano: paga antes de entrar, o modo de cobrança não decide o roteador", async () => {
    h.settings = { modo: "avisar", compra_pelo_cliente: true };
    expect(await rotear()).toBe("/onboarding/plano");
    expect(h.atualizacoes).toEqual([]);
  });

  it("⭐ conta sem plano com a carência de 5 s ainda correndo: paga antes de entrar", async () => {
    h.contrato = { ...SEM_PLANO, bloqueio_a_partir_de: AMANHA };
    expect(await rotear()).toBe("/onboarding/plano");
    expect(h.atualizacoes).toEqual([]);
  });

  it("conta com o plano liberado pelo admin da plataforma (sem o marcador de 'sem plano'): entra pelo Início", async () => {
    h.settingsDaOrg = {};
    h.contrato = { status: "ativa", cycle: null, current_period_end: null, bloqueio_a_partir_de: null };
    expect(await rotear()).toBe("/app/inicio");
  });

  it("⭐ a leitura do contrato FALHA: NÃO conclui o onboarding (fail-closed) e mostra o erro com a saída", async () => {
    h.contratoErro = true;
    const saida = await OnboardingIndex();
    expect(saida).toBeTruthy(); // devolveu a tela de erro em vez de redirecionar
    expect(h.redirecionou).toEqual([]);
    expect(h.atualizacoes).toEqual([]);
    expect(h.eventos).toEqual([]);
    expect(h.auditorias).toEqual([]);
    expect(JSON.stringify(saida)).toContain("/onboarding"); // o "Tentar novamente"
  });

  it("depois que a leitura volta a funcionar, o mesmo caminho conclui normalmente", async () => {
    h.contrato = ATIVO;
    h.contratoErro = true;
    await OnboardingIndex();
    expect(h.atualizacoes).toEqual([]);
    h.contratoErro = false;
    expect(await rotear()).toBe("/app/inicio");
    expect(h.atualizacoes).toHaveLength(1);
  });

  it("conta de suporte só observa: não conclui o onboarding de ninguém", async () => {
    h.suporte = true;
    h.contrato = ATIVO;
    expect(await rotear()).toBe("/app/inbox");
    expect(h.atualizacoes).toEqual([]);
  });
});

describe("roteador com a compra desligada: o wizard antigo, intacto", () => {
  beforeEach(() => {
    h.env.ASAAS_ENABLED = false;
  });

  it("estado vazio começa nas boas-vindas", async () => {
    expect(await rotear()).toBe("/onboarding/welcome");
  });

  it("tudo resolvido termina na tela final, e NÃO conclui sozinho (quem conclui é o botão dela)", async () => {
    h.onboardingState = {
      welcome: { accepted_at: "x", timezone: "America/Sao_Paulo", display_name: "N" },
      whatsapp: { status: "WORKING" },
      ai: { agent_id: "a", prompt_template: "p" },
      funil: { pipeline_id: "f", origem: "ia", etapas: 6 },
      teste: { respondeu: true },
      team: { invites_sent: 0, skipped: true },
    };
    expect(await rotear()).toBe("/onboarding/done");
    expect(h.atualizacoes).toEqual([]);
  });

  it("quem já concluiu vai para o inbox, como sempre", async () => {
    h.onboardedAt = "2026-09-01T10:00:00Z";
    expect(await rotear()).toBe("/app/inbox");
  });
});
