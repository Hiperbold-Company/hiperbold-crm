/**
 * `trocarFormaDePagamento` (`app/actions/settings/compraDoPlano.ts`): a camada da AÇÃO do botão "Trocar forma de
 * pagamento" do passo Plano do onboarding: só o admin da organização, com teto de tentativas, auditada, sem
 * receber id de pedido nem de organização (é o pedido aberto da organização da SESSÃO). A remoção no Asaas e a
 * recusa quando o pagamento já entrou são provadas em `asaas-compra.test.ts` (`cancelarPedidoAbertoDoCliente`); aqui
 * esse serviço é o dublê.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

let papel = "admin";
let supportBloqueado = false;
let mfaPendente = false;
let habilitado = true;
let limitadoPorUsuario = false;
let limitadoPorOrg = false;
let resultado: unknown = { tipo: "ok", cancelou: true };

const auditadas: Array<Record<string, unknown>> = [];
const chamadas: Array<{ org: string }> = [];
const limites: Array<{ acao: string; id: string }> = [];
const revalidadas: string[] = [];

vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>([["x-request-id", "req"]]) }));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    revalidadas.push(p);
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: vi.fn(async (acao: string, id: string) => {
    limites.push({ acao, id });
    return acao === "trocar_pagamento" ? limitadoPorUsuario : limitadoPorOrg;
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: vi.fn(() => (supportBloqueado ? "bloqueado" : null)) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: false, support: null })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: papel })),
  mfaEmDivida: vi.fn(async () => mfaPendente),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marca: "admin-falso" }) }));
vi.mock("@/lib/billing/asaas/db-compra-supabase", () => ({ dbCompraSupabase: vi.fn(() => ({})) }));
vi.mock("@/lib/billing/asaas/cliente", () => ({ criarClienteAsaas: vi.fn(() => ({})) }));
vi.mock("@/lib/billing/asaas/config", () => ({
  configDoAsaas: vi.fn(() => ({
    habilitado,
    baseUrl: "https://api-sandbox.asaas.com/v3",
    apiKey: "$aact_hmlg_x",
    webhookToken: "t",
    webhookId: "",
    ambiente: "sandbox" as const,
  })),
  compraLigada: vi.fn(async () => true),
}));
vi.mock("@/lib/billing/asaas/pix", () => ({ pixDisponivel: vi.fn(async () => true) }));
vi.mock("@/lib/billing/asaas/compra", () => ({
  cancelarPedidoAbertoDoCliente: vi.fn(async (_deps: unknown, org: string) => {
    chamadas.push({ org });
    return resultado;
  }),
}));

import { trocarFormaDePagamento } from "@/app/actions/settings/compraDoPlano";

beforeEach(() => {
  papel = "admin";
  supportBloqueado = false;
  mfaPendente = false;
  habilitado = true;
  limitadoPorUsuario = false;
  limitadoPorOrg = false;
  resultado = { tipo: "ok", cancelou: true };
  auditadas.length = 0;
  chamadas.length = 0;
  limites.length = 0;
  revalidadas.length = 0;
});

describe("trocarFormaDePagamento", () => {
  it("admin da organização: cancela o pedido aberto DA SESSÃO, audita e atualiza a tela do passo", async () => {
    expect(await trocarFormaDePagamento()).toEqual({ tipo: "ok", cancelou: true });
    expect(chamadas).toEqual([{ org: ORG }]);
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]).toMatchObject({
      action: "billing.order_payment_method_reset",
      actorUserId: USER,
      organizationId: ORG,
      metadata: { tipo: "assinatura" },
    });
    expect(JSON.stringify(auditadas[0])).not.toMatch(/documento|cpf|email/i);
    expect(revalidadas).toContain("/onboarding/plano");
  });

  it("quem não é admin (gerente, agente, leitor) é recusado antes de qualquer coisa", async () => {
    for (const p of ["manager", "agent", "viewer"]) {
      papel = p;
      const r = await trocarFormaDePagamento();
      expect(r.tipo).toBe("erro");
    }
    expect(chamadas).toHaveLength(0);
    expect(auditadas).toHaveLength(0);
    expect(limites).toHaveLength(0);
  });

  it("sessão de suporte somente leitura é recusada", async () => {
    supportBloqueado = true;
    expect((await trocarFormaDePagamento()).tipo).toBe("erro");
    expect(chamadas).toHaveLength(0);
  });

  it("admin com fator e sessão sem MFA provada é recusado antes do teto, do Asaas e da auditoria", async () => {
    mfaPendente = true;
    expect(await trocarFormaDePagamento()).toEqual({ tipo: "erro", mensagem: "Confirme a verificação em duas etapas." });
    expect(chamadas).toHaveLength(0);
    expect(auditadas).toHaveLength(0);
    expect(limites).toHaveLength(0);
  });

  it("tem teto de tentativas por usuário e por organização: estourou, o Asaas nem é tocado", async () => {
    limitadoPorUsuario = true;
    expect((await trocarFormaDePagamento()).tipo).toBe("erro");
    limitadoPorUsuario = false;
    limitadoPorOrg = true;
    expect((await trocarFormaDePagamento()).tipo).toBe("erro");
    expect(chamadas).toHaveLength(0);
    expect(limites.map((l) => l.acao)).toContain("trocar_pagamento_org");
  });

  it("Asaas desligado nesta instalação: recusa sem chamar o serviço", async () => {
    habilitado = false;
    expect((await trocarFormaDePagamento()).tipo).toBe("erro");
    expect(chamadas).toHaveLength(0);
  });

  it("pagamento em confirmação (o serviço recusou): devolve a frase e NÃO audita nem atualiza a tela", async () => {
    resultado = { tipo: "erro", mensagem: "Seu pagamento está em confirmação." };
    expect(await trocarFormaDePagamento()).toEqual({ tipo: "erro", mensagem: "Seu pagamento está em confirmação." });
    expect(auditadas).toHaveLength(0);
    expect(revalidadas).toHaveLength(0);
  });

  it("sem pedido aberto (idempotente): ok, sem auditoria de cancelamento", async () => {
    resultado = { tipo: "ok", cancelou: false };
    expect(await trocarFormaDePagamento()).toEqual({ tipo: "ok", cancelou: false });
    expect(auditadas).toHaveLength(0);
  });
});
