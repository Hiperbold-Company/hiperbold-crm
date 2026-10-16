/**
 * `solicitarReembolso` (migration 0957): a camada da AÇÃO: sessão, papel admin, forma da entrada, teto de
 * tentativas, tradução do erro do banco para frase fixa (inclusive "fora dos 7 dias"), auditoria sem o texto
 * livre e e-mails enfileirados. A regra de negócio (cancelada, mais recente, 7 dias) mora no banco e é provada
 * em `tests/invariants/reembolso-do-cliente-banco.test.ts`; aqui o banco é a borda (um dublê de `rpc`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const PAGAMENTO = "33333333-3333-4333-8333-333333333333";
const PEDIDO = "44444444-4444-4444-8444-444444444444";

let papel = "admin";
let supportBloqueado = false;
let limitado = false;
let erroDoBanco: { code?: string; message: string } | null = null;
const auditadas: Array<Record<string, unknown>> = [];
const chamadasRpc: Array<{ nome: string; args: Record<string, unknown> }> = [];
const limites: Array<{ acao: string; id: string | null }> = [];
const enfileiradas: Array<Record<string, unknown>> = [];

vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>([["x-request-id", "req"]]) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: vi.fn(() => (supportBloqueado ? "bloqueado" : null)) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, support: null })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: papel })),
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: vi.fn(async (acao: string, id: string | null) => {
    limites.push({ acao, id });
    return limitado;
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    marca: "admin-falso",
    rpc: async (nome: string, args: Record<string, unknown>) => {
      chamadasRpc.push({ nome, args });
      if (erroDoBanco) return { data: null, error: erroDoBanco };
      return {
        data: {
          id: PEDIDO,
          payment_id: PAGAMENTO,
          asaas_payment_id: "pay_abc123",
          amount_cents: 34900,
          paid_at: "2026-10-13T12:00:00+00:00",
          dentro_7_dias: true,
          motivo: "preco",
          motivo_detalhe: "caro demais",
          plano: "Pro",
          pacote: false,
          invoice_url: null,
          ambiente: "producao",
        },
        error: null,
      };
    },
  }),
}));
vi.mock("@/lib/email/conta-e-cobranca/fila", () => ({
  enfileirarEmailDeConta: vi.fn(async (e: Record<string, unknown>) => {
    enfileiradas.push(e);
    return "enfileirado";
  }),
}));

import { solicitarReembolso } from "@/app/actions/settings/reembolso";

beforeEach(() => {
  papel = "admin";
  supportBloqueado = false;
  limitado = false;
  erroDoBanco = null;
  auditadas.length = 0;
  chamadasRpc.length = 0;
  limites.length = 0;
  enfileiradas.length = 0;
});

describe("quem pode pedir", () => {
  for (const sem of ["viewer", "agent", "manager"]) {
    it(`${sem} é recusado antes de qualquer leitura ou escrita`, async () => {
      papel = sem;
      const r = await solicitarReembolso({ paymentId: PAGAMENTO });
      expect(r.tipo).toBe("erro");
      expect(chamadasRpc).toEqual([]);
      expect(auditadas).toEqual([]);
      expect(enfileiradas).toEqual([]);
    });
  }

  it("sessão de suporte em modo só leitura é recusada", async () => {
    supportBloqueado = true;
    expect((await solicitarReembolso({ paymentId: PAGAMENTO })).tipo).toBe("erro");
    expect(chamadasRpc).toEqual([]);
  });
});

describe("a entrada", () => {
  it("pagamento que não é uuid e observação acima de 1000 caracteres são recusados", async () => {
    for (const entrada of [{ paymentId: "abc" }, { paymentId: PAGAMENTO, detalhe: "x".repeat(1001) }]) {
      const r = await solicitarReembolso(entrada);
      expect(r).toEqual({ tipo: "erro", mensagem: "Dados inválidos. Confira o formulário e tente de novo." });
    }
    expect(chamadasRpc).toEqual([]);
  });

  it("a organização e o ator vão da sessão, nunca do input", async () => {
    await solicitarReembolso({ paymentId: PAGAMENTO, ...({ organizationId: "outra" } as object) });
    expect(chamadasRpc).toHaveLength(1);
    expect(chamadasRpc[0]!.args).toMatchObject({ p_org: ORG, p_actor: USER, p_payment: PAGAMENTO });
    expect(JSON.stringify(chamadasRpc[0]!.args)).not.toContain("outra");
  });
});

describe("teto de tentativas", () => {
  it("passou do limite: recusa sem tocar no banco, com contagem por usuário e por organização", async () => {
    limitado = true;
    const r = await solicitarReembolso({ paymentId: PAGAMENTO });
    expect(r).toEqual({ tipo: "erro", mensagem: "Muitas tentativas. Tente de novo mais tarde." });
    expect(chamadasRpc).toEqual([]);
  });

  it("conta as tentativas por usuário e por organização (5 por dia)", async () => {
    await solicitarReembolso({ paymentId: PAGAMENTO });
    expect(limites).toEqual([
      { acao: "reembolso", id: USER },
      { acao: "reembolso_org", id: ORG },
    ]);
  });
});

describe("o banco recusa: frases fixas", () => {
  const casos: Array<[string, string]> = [
    ["billing_reembolso_fora_do_prazo", "O prazo de 7 dias de garantia já passou, então não é possível pedir reembolso desta cobrança."],
    ["billing_reembolso_so_o_ultimo_pagamento", "O prazo de 7 dias de garantia já passou, então não é possível pedir reembolso desta cobrança."],
    ["billing_reembolso_assinatura_nao_cancelada", "Cancele a assinatura antes de pedir o reembolso."],
    ["billing_reembolso_ja_solicitado", "Já existe um pedido de reembolso em análise para este pagamento."],
    ["billing_reembolso_limite_diario", "Você chegou ao limite de pedidos de hoje. Tente amanhã."],
    ["billing_reembolso_pagamento_nao_elegivel", "Este pagamento não pode ser reembolsado."],
  ];
  it.each(casos)("%s", async (codigo, frase) => {
    erroDoBanco = { code: "22023", message: codigo };
    const r = await solicitarReembolso({ paymentId: PAGAMENTO });
    expect(r).toEqual({ tipo: "erro", mensagem: frase });
    expect(auditadas).toEqual([]);
    expect(enfileiradas).toEqual([]);
  });

  it("erro desconhecido vira a frase genérica, nunca o texto do Postgres", async () => {
    erroDoBanco = { code: "XX000", message: "relation foo does not exist" };
    const r = await solicitarReembolso({ paymentId: PAGAMENTO });
    expect(r.tipo).toBe("erro");
    expect(JSON.stringify(r)).not.toContain("relation");
  });
});

describe("pedido gravado", () => {
  it("audita billing.refund_requested com o motivo e sem o texto livre", async () => {
    const r = await solicitarReembolso({ paymentId: PAGAMENTO, detalhe: "segredo da observação" });
    expect(r).toEqual({ tipo: "ok" });
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]).toMatchObject({ action: "billing.refund_requested", organizationId: ORG, actorUserId: USER });
    expect(auditadas[0]!.metadata).toMatchObject({
      pedido_id: PEDIDO,
      pagamento_asaas: "pay_abc123",
      amount_cents: 34900,
      dentro_7_dias: true,
      motivo: "preco",
      com_observacao: true,
    });
    expect(JSON.stringify(auditadas)).not.toContain("segredo da observação");
    expect(JSON.stringify(auditadas)).not.toContain("caro demais");
  });

  it("enfileira o aviso ao cliente (COB-10, admins) e o do financeiro (COB-11, destino financeiro)", async () => {
    await solicitarReembolso({ paymentId: PAGAMENTO, detalhe: "obrigado" });
    expect(enfileiradas.map((e) => [e.emailId, e.destino, e.chave, e.organizationId])).toEqual([
      ["COB-10", "admins", `reembolso:${PEDIDO}`, ORG],
      ["COB-11", "financeiro", `reembolso:${PEDIDO}`, ORG],
    ]);
    const financeiro = enfileiradas[1]!.dados as Record<string, unknown>;
    expect(financeiro).toMatchObject({
      valor: 34900,
      plano: "Pro",
      dentro7Dias: true,
      motivo: "preco",
      faturaUrl: "https://www.asaas.com/i/abc123",
    });
    expect(String(financeiro.detalhe)).toContain("caro demais");
    expect(String(financeiro.detalhe)).toContain("obrigado");
    expect(JSON.stringify(enfileiradas)).not.toMatch(/@/);
  });
});
