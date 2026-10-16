import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As ações do admin da PLATAFORMA sobre pedidos de reembolso e motivos de cancelamento
 * (`app/actions/admin/reembolsos.ts`, migration 0957): gate (escopo `full` e MFA, inclusive na leitura), a lista
 * com os pendentes primeiro e o link do Asaas, a resolução (recusar / marcar concluído) com auditoria sem o
 * texto livre. A regra mora no banco (`tests/invariants/reembolso-do-cliente-banco.test.ts`).
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const PEDIDO = "33333333-3333-4333-8333-333333333333";
const ORG_A = "0957c000-0000-4000-8000-00000000000a";
const ORG_B = "0957c000-0000-4000-8000-00000000000b";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  mfaEmDivida: vi.fn(),
  tabelas: {} as Record<string, unknown[]>,
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: h.guard }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfaEmDivida }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: h.rpc,
    from: (tabela: string) => {
      const q: Record<string, unknown> = {
        select: () => q,
        order: () => q,
        limit: async () => ({ data: h.tabelas[tabela] ?? [], error: null }),
        in: async () => ({ data: h.tabelas[tabela] ?? [], error: null }),
      };
      return q;
    },
  }),
}));

const ADMIN_FULL = { user: { id: USUARIO }, platformAdmin: { scope: "full" } };
const ADMIN_SUPORTE = { user: { id: USUARIO }, platformAdmin: { scope: "support_readonly" } };

async function acoes() {
  return import("@/app/actions/admin/reembolsos");
}

function linha(id: string, org: string, status: string, criado: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: org,
    order_id: null,
    asaas_payment_id: "pay_abc123",
    amount_cents: 34900,
    paid_at: "2026-10-13T12:00:00+00:00",
    dentro_7_dias: true,
    motivo: "preco",
    detalhe: null,
    status,
    created_at: criado,
    resolved_at: status === "pendente" ? null : "2026-10-14T12:00:00+00:00",
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue(ADMIN_FULL);
  h.mfaEmDivida.mockResolvedValue(false);
  h.tabelas = {};
  h.rpc.mockResolvedValue({
    data: { id: PEDIDO, organization_id: ORG_A, asaas_payment_id: "pay_abc123", amount_cents: 34900, status_anterior: "pendente", status_novo: "recusado" },
    error: null,
  });
});

describe("gate", () => {
  it("escopo diferente de full e MFA em dívida recusam as três ações, sem banco nem auditoria", async () => {
    const { listarPedidosDeReembolso, listarMotivosDeCancelamento, resolverPedidoDeReembolso } = await acoes();
    for (const cenario of ["suporte", "mfa"]) {
      if (cenario === "suporte") h.guard.mockResolvedValue(ADMIN_SUPORTE);
      else {
        h.guard.mockResolvedValue(ADMIN_FULL);
        h.mfaEmDivida.mockResolvedValue(true);
      }
      expect((await listarPedidosDeReembolso()).ok).toBe(false);
      expect((await listarMotivosDeCancelamento()).ok).toBe(false);
      expect((await resolverPedidoDeReembolso({ pedidoId: PEDIDO, status: "recusado" })).ok).toBe(false);
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("listarPedidosDeReembolso", () => {
  it("pendentes primeiro (o mais antigo antes), depois os resolvidos, com empresa e link do Asaas", async () => {
    h.tabelas.billing_refund_requests = [
      linha("r-concluido", ORG_B, "concluido", "2026-10-14T10:00:00+00:00"),
      linha("r-novo", ORG_A, "pendente", "2026-10-15T10:00:00+00:00", { order_id: "ord-1", detalhe: "obrigado" }),
      linha("r-velho", ORG_B, "pendente", "2026-10-14T09:00:00+00:00"),
    ];
    h.tabelas.organizations = [
      { id: ORG_A, display_name: "Empresa A" },
      { id: ORG_B, display_name: "Empresa B" },
    ];
    h.tabelas.billing_orders = [{ id: "ord-1", invoice_url: "https://www.asaas.com/i/fatura9", ambiente: "producao" }];

    const { listarPedidosDeReembolso } = await acoes();
    const r = await listarPedidosDeReembolso();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pedidos.map((p) => p.id)).toEqual(["r-velho", "r-novo", "r-concluido"]);
    const novo = r.pedidos.find((p) => p.id === "r-novo")!;
    expect(novo).toMatchObject({ empresa: "Empresa A", amountCents: 34900, dentro7Dias: true, motivo: "preco", detalhe: "obrigado" });
    expect(novo.linkDoAsaas).toBe("https://www.asaas.com/i/fatura9");
    expect(r.pedidos.find((p) => p.id === "r-velho")!.linkDoAsaas).toBe("https://www.asaas.com/i/abc123");
  });
});

describe("listarMotivosDeCancelamento", () => {
  it("devolve motivo, detalhe e empresa", async () => {
    h.tabelas.billing_cancel_feedback = [
      { id: "m1", organization_id: ORG_A, motivo: "faltou_recurso", detalhe: "relatórios", created_at: "2026-10-14T10:00:00+00:00" },
    ];
    h.tabelas.organizations = [{ id: ORG_A, display_name: "Empresa A" }];
    const { listarMotivosDeCancelamento } = await acoes();
    const r = await listarMotivosDeCancelamento();
    expect(r).toEqual({
      ok: true,
      motivos: [
        { id: "m1", organizationId: ORG_A, empresa: "Empresa A", motivo: "faltou_recurso", detalhe: "relatórios", createdAt: "2026-10-14T10:00:00+00:00" },
      ],
    });
  });
});

describe("resolverPedidoDeReembolso", () => {
  it("recusar: chama a função do banco com o ator da sessão e audita billing.refund_rejected sem dado do cliente", async () => {
    const { resolverPedidoDeReembolso } = await acoes();
    expect(await resolverPedidoDeReembolso({ pedidoId: PEDIDO, status: "recusado" })).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("fn_billing_reembolso_resolver", { p_request: PEDIDO, p_status: "recusado", p_actor: USUARIO });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({
      action: "billing.refund_rejected",
      actorUserId: USUARIO,
      actingAsPlatformAdmin: true,
      organizationId: ORG_A,
      resourceId: PEDIDO,
      metadata: { pagamento_asaas: "pay_abc123", amount_cents: 34900 },
    });
  });

  it("marcar concluído audita billing.refund_marked_done", async () => {
    h.rpc.mockResolvedValue({
      data: { id: PEDIDO, organization_id: ORG_A, asaas_payment_id: "pay_abc123", amount_cents: 34900, status_novo: "concluido" },
      error: null,
    });
    const { resolverPedidoDeReembolso } = await acoes();
    await resolverPedidoDeReembolso({ pedidoId: PEDIDO, status: "concluido" });
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ action: "billing.refund_marked_done" });
  });

  it("entrada inválida e status 'pendente' são recusados antes do banco", async () => {
    const { resolverPedidoDeReembolso } = await acoes();
    expect((await resolverPedidoDeReembolso({ pedidoId: "x", status: "recusado" })).ok).toBe(false);
    expect((await resolverPedidoDeReembolso({ pedidoId: PEDIDO, status: "pendente" as never })).ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("pedido já resolvido ou inexistente vira frase fixa, sem auditoria", async () => {
    const { resolverPedidoDeReembolso } = await acoes();
    h.rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "billing_reembolso_ja_resolvido" } });
    expect(await resolverPedidoDeReembolso({ pedidoId: PEDIDO, status: "recusado" })).toEqual({ ok: false, error: "Este pedido já foi resolvido." });
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "billing_reembolso_nao_encontrado" } });
    expect(await resolverPedidoDeReembolso({ pedidoId: PEDIDO, status: "recusado" })).toEqual({ ok: false, error: "Pedido não encontrado." });
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "relation x does not exist" } });
    const r = await resolverPedidoDeReembolso({ pedidoId: PEDIDO, status: "recusado" });
    expect(JSON.stringify(r)).not.toContain("relation");
    expect(h.audit).not.toHaveBeenCalled();
  });
});
