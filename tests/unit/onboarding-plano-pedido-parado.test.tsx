/**
 * O PASSO "PLANO" NÃO PODE PRENDER O CLIENTE NUM PEDIDO QUE NÃO VAI ANDAR.
 *
 * Mede a PÁGINA `/onboarding/plano` com o código real da página, de `pedidoDaAssinatura` e de
 * `podeEscolherOutraForma`; dublê só nas bordas (sessão, banco no formato do PostgREST, leitura do
 * catálogo e os componentes de cliente, trocados por marcadores). Pergunta: o que a tela mostra, a
 * espera do pagamento ou o formulário?
 *
 * Comando: npx vitest run tests/unit/onboarding-plano-pedido-parado.test.tsx
 */
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGORA = Date.now();
const ha = (ms: number) => new Date(AGORA - ms).toISOString();
const HORA = 3_600_000;

const h = vi.hoisted(() => ({
  pedido: null as null | { id: string; status: string; metodo: string; invoice_url: string | null; created_at: string },
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
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { user_metadata: {} } } }) } }),
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
    planos: [{ code: "pro" }],
    opcoesDeParcelas: [],
    taxaMensalPercentual: 0,
    precisaPagador: false,
    planoAtualCode: null,
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

/** Nomes dos componentes e `data-testid` presentes na árvore devolvida pela página. */
function marcas(no: ReactNode, acc: string[] = []): string[] {
  if (!no || typeof no !== "object") return acc;
  if (Array.isArray(no)) {
    no.forEach((n) => marcas(n, acc));
    return acc;
  }
  const el = no as ReactElement<{ children?: ReactNode; "data-testid"?: string }>;
  if (typeof el.type === "function") acc.push((el.type as { name: string }).name);
  if (el.props?.["data-testid"]) acc.push(el.props["data-testid"]);
  marcas(el.props?.children, acc);
  return acc;
}

async function tela(): Promise<string[]> {
  return marcas(await PlanoPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  h.pedido = null;
});

describe("/onboarding/plano com um pedido de assinatura aberto", () => {
  it("sem pedido: o formulário", async () => {
    const m = await tela();
    expect(m).toContain("AssinarPlanoPassoAPasso");
    expect(m).not.toContain("AguardandoPagamento");
  });

  it("Pix recente a pagar: a espera, sem formulário (não se abre segundo pedido)", async () => {
    h.pedido = { id: "p1", status: "aguardando_pagamento", metodo: "PIX", invoice_url: "https://x.test/i", created_at: ha(HORA) };
    const m = await tela();
    expect(m).toContain("AguardandoPagamento");
    expect(m).not.toContain("AssinarPlanoPassoAPasso");
    expect(m).not.toContain("plano-pedido-parado");
  });

  it("⭐ inconclusivo SEM fatura: o formulário volta, com o aviso, em vez de uma espera sem saída", async () => {
    h.pedido = { id: "p2", status: "inconclusivo", metodo: "PIX", invoice_url: null, created_at: ha(60_000) };
    const m = await tela();
    expect(m).toContain("AssinarPlanoPassoAPasso");
    expect(m).toContain("plano-pedido-parado");
    expect(m).not.toContain("AguardandoPagamento");
  });

  it("⭐ pedido aberto há mais de 24 h: o formulário volta, com o aviso", async () => {
    h.pedido = { id: "p3", status: "aguardando_pagamento", metodo: "PIX", invoice_url: "https://x.test/i", created_at: ha(25 * HORA) };
    const m = await tela();
    expect(m).toContain("AssinarPlanoPassoAPasso");
    expect(m).toContain("plano-pedido-parado");
  });

  it("pedido pago (mesmo antigo): continua na tela de ativação, nunca no formulário", async () => {
    h.pedido = { id: "p4", status: "pago", metodo: "PIX", invoice_url: null, created_at: ha(48 * HORA) };
    const m = await tela();
    expect(m).toContain("AguardandoPagamento");
    expect(m).not.toContain("AssinarPlanoPassoAPasso");
  });
});
