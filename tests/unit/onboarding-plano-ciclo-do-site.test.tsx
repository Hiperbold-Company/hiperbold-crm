/**
 * O CICLO DO SITE (`/signup?plano=max&ciclo=yearly`) CHEGA À TELA DE PAGAMENTO DO ONBOARDING.
 *
 * Mede a PÁGINA `/onboarding/plano` com o código real: o `ciclo` vem do `?ciclo=` e, na falta, do
 * `user_metadata.ciclo_escolhido` que o cadastro guardou, e só vale se o plano pré-selecionado o vende.
 * Dublê só nas bordas (sessão, banco, catálogo e o componente de cliente, trocado por um que guarda as props).
 *
 * Comando: npx vitest run tests/unit/onboarding-plano-ciclo-do-site.test.tsx
 */
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  pedido: null as null,
  metadata: {} as Record<string, unknown>,
}));

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NUVEMSHOP_ENABLED: false,
    ASAAS_ENABLED: true,
    ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
    ASAAS_API_KEY: "$aact_hmlg_teste",
    ASAAS_WEBHOOK_TOKEN: "",
    ASAAS_WEBHOOK_ID: "",
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({ id: "u1", idioma: "pt-BR" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "QA", role: "admin" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { user_metadata: h.metadata } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) b[m] = () => b;
      const ler = () => {
        if (tabela === "billing_settings") return { data: { modo: "bloquear", compra_pelo_cliente: true }, error: null };
        if (tabela === "organizations") return { data: { settings: { billing_inicio: "sem_plano" } }, error: null };
        if (tabela === "billing_contracts") {
          return { data: { status: "suspensa", cycle: null, current_period_end: null }, error: null };
        }
        if (tabela === "billing_orders") return { data: h.pedido, error: null };
        throw new Error(`tabela não dublada: ${tabela}`);
      };
      b.maybeSingle = async () => ler();
      b.single = async () => ler();
      return b;
    },
  }),
}));
vi.mock("@/app/app/settings/plano/assinar/_dados", () => ({
  dadosDaCompraDePlano: async () => ({
    planos: [
      { code: "pro", priceMonthlyCents: 19900, priceSemiannualCents: 109900, priceYearlyCents: null },
      { code: "max", priceMonthlyCents: 39900, priceSemiannualCents: 219900, priceYearlyCents: 399000 },
    ],
    opcoesDeParcelas: [],
    taxaMensalPercentual: 0,
    precisaPagador: false,
    planoAtualCode: null,
    pixDisponivel: true,
    leituraFalhou: false,
  }),
}));
vi.mock("@/app/app/settings/plano/assinar/_passo-a-passo", () => ({
  AssinarPlanoPassoAPasso: function AssinarPlanoPassoAPasso() {
    return null;
  },
}));
vi.mock("@/app/onboarding/plano/_aguardando", () => ({
  AguardandoPagamento: function AguardandoPagamento() {
    return null;
  },
}));

import PlanoPage from "@/app/onboarding/plano/page";

type PropsDaTela = { planoInicial: string | null; cicloInicial: string | null };

/** Acha, na árvore devolvida pela página, o elemento do formulário de assinatura e devolve as props dele. */
function achar(no: ReactNode): PropsDaTela | null {
  if (!no || typeof no !== "object") return null;
  if (Array.isArray(no)) {
    for (const n of no) {
      const r = achar(n);
      if (r) return r;
    }
    return null;
  }
  const el = no as ReactElement<{ children?: ReactNode } & PropsDaTela>;
  if (typeof el.type === "function" && (el.type as { name: string }).name === "AssinarPlanoPassoAPasso") return el.props;
  return achar(el.props?.children);
}

async function propsDaTela(searchParams: Record<string, string | string[]>, metadata: Record<string, unknown> = {}) {
  h.metadata = metadata;
  const props = achar(await PlanoPage({ searchParams: Promise.resolve(searchParams) }));
  expect(props).not.toBeNull();
  return props as PropsDaTela;
}

beforeEach(() => {
  h.metadata = {};
});

describe("/onboarding/plano: o ciclo do site chega pré-selecionado", () => {
  it("?plano=max&ciclo=yearly: plano e ciclo seguem para a tela", async () => {
    expect(await propsDaTela({ plano: "max", ciclo: "yearly" })).toMatchObject({ planoInicial: "max", cicloInicial: "yearly" });
  });

  it("sem a URL, vale o que o cadastro guardou no user_metadata (mesmo caminho do plano)", async () => {
    const p = await propsDaTela({}, { plano_escolhido: "max", ciclo_escolhido: "semiannual" });
    expect(p).toMatchObject({ planoInicial: "max", cicloInicial: "semiannual" });
  });

  it("o apelido scale do site continua virando escale e o ciclo é conferido contra ESSE plano", async () => {
    // `escale` não está no catálogo dublado: plano fora de venda não marca nada, e o ciclo não marca sozinho.
    expect(await propsDaTela({ plano: "scale", ciclo: "yearly" })).toMatchObject({ planoInicial: null, cicloInicial: null });
  });

  it("ciclo inválido é ignorado sem erro; o plano continua marcado", async () => {
    expect(await propsDaTela({ plano: "max", ciclo: "anual" })).toMatchObject({ planoInicial: "max", cicloInicial: null });
    expect(await propsDaTela({ plano: "max", ciclo: ["<script>", "yearly"] })).toMatchObject({ cicloInicial: null });
  });

  it("ciclo ausente não muda nada", async () => {
    expect(await propsDaTela({ plano: "max" })).toMatchObject({ planoInicial: "max", cicloInicial: null });
  });

  it("ciclo que o plano não vende (Pro sem anual) é ignorado", async () => {
    expect(await propsDaTela({ plano: "pro", ciclo: "yearly" })).toMatchObject({ planoInicial: "pro", cicloInicial: null });
    expect(await propsDaTela({ plano: "pro", ciclo: "semiannual" })).toMatchObject({ planoInicial: "pro", cicloInicial: "semiannual" });
  });

  it("ciclo sem plano pré-selecionado não marca nada", async () => {
    expect(await propsDaTela({ ciclo: "yearly" })).toMatchObject({ planoInicial: null, cicloInicial: null });
  });
});
