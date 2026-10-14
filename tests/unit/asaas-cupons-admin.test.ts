import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As três ações do admin da PLATAFORMA sobre cupons (`app/actions/admin/cupons.ts`, migration 0955), no molde de
 * `asaas-acoes-do-admin.test.ts`: gate (escopo `full` e MFA), forma da entrada, o que vai à RPC, a tradução dos
 * erros do banco e a auditoria sem dado pessoal. O comportamento das regras (validade, usos, piso) é provado em
 * banco por `tests/invariants/cupons-banco.test.ts`.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const CUPOM = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  mfaEmDivida: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: h.guard }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfaEmDivida }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const ADMIN_FULL = { user: { id: USUARIO }, platformAdmin: { scope: "full" } };
const ADMIN_SUPORTE = { user: { id: USUARIO }, platformAdmin: { scope: "support_readonly" } };

const ENTRADA_VALIDA = { codigo: "PCT10", tipo: "percentual" as const, valor: 10 };

async function acoes() {
  return import("@/app/actions/admin/cupons");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue(ADMIN_FULL);
  h.mfaEmDivida.mockResolvedValue(false);
  h.rpc.mockResolvedValue({ data: { id: CUPOM, codigo: "PCT10", tipo: "percentual", valor: 10 }, error: null });
});

describe("gate das três ações", () => {
  it("escopo diferente de full é recusado, sem RPC nem auditoria", async () => {
    const { criarCupom, definirCupomAtivo, listarCupons } = await acoes();
    h.guard.mockResolvedValue(ADMIN_SUPORTE);
    expect((await criarCupom(ENTRADA_VALIDA)).ok).toBe(false);
    expect((await definirCupomAtivo({ cupomId: CUPOM, ativo: false })).ok).toBe(false);
    expect((await listarCupons()).ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("MFA em dívida é recusado, sem RPC nem auditoria", async () => {
    const { criarCupom, definirCupomAtivo, listarCupons } = await acoes();
    h.mfaEmDivida.mockResolvedValue(true);
    expect(await criarCupom(ENTRADA_VALIDA)).toEqual({ ok: false, error: "Confirme a verificação em duas etapas." });
    expect((await definirCupomAtivo({ cupomId: CUPOM, ativo: true })).ok).toBe(false);
    expect((await listarCupons()).ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("criarCupom", () => {
  it("manda à função do banco o que foi pedido, com o ator da sessão, e audita só o cupom", async () => {
    const { criarCupom } = await acoes();
    const r = await criarCupom({
      codigo: " PCT10 ",
      tipo: "percentual",
      valor: 10,
      planos: ["pro", "max"],
      ciclos: ["yearly"],
      validoAte: "2030-01-01T00:00:00Z",
      maxUsos: 50,
      descricao: "Campanha de lançamento",
    });

    expect(r).toEqual({ ok: true, dados: { id: CUPOM, codigo: "PCT10", tipo: "percentual", valor: 10 } });
    expect(h.rpc).toHaveBeenCalledWith("fn_billing_cupom_criar", {
      p_codigo: "PCT10",
      p_tipo: "percentual",
      p_valor: 10,
      p_planos: ["pro", "max"],
      p_ciclos: ["yearly"],
      p_valido_ate: "2030-01-01T00:00:00Z",
      p_max_usos: 50,
      p_descricao: "Campanha de lançamento",
      p_actor: USUARIO,
    });
    expect(h.audit).toHaveBeenCalledTimes(1);
    const evento = h.audit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(evento).toMatchObject({ action: "billing.coupon_created", actorUserId: USUARIO, actingAsPlatformAdmin: true, resourceId: CUPOM });
    expect(evento.metadata).toMatchObject({ codigo: "PCT10", tipo: "percentual", valor: 10, planos: ["pro", "max"], ciclos: ["yearly"], max_usos: 50 });
    expect(JSON.stringify(evento.metadata)).not.toContain("Campanha");
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/sistema/cupons");
  });

  it("sem restrições: listas vazias e limites nulos", async () => {
    const { criarCupom } = await acoes();
    await criarCupom(ENTRADA_VALIDA);
    expect(h.rpc.mock.calls[0]?.[1]).toMatchObject({ p_planos: [], p_ciclos: [], p_valido_ate: null, p_max_usos: null, p_descricao: null });
  });

  it("entrada inválida não chega ao banco: percentual 0 e 100, valor 0 ou fracionado, código ruim, ciclo estranho, validade sem fuso", async () => {
    const { criarCupom } = await acoes();
    const ruins = [
      { ...ENTRADA_VALIDA, valor: 0 },
      { ...ENTRADA_VALIDA, valor: 100 },
      { ...ENTRADA_VALIDA, valor: 10.5 },
      { codigo: "PROMO", tipo: "valor" as const, valor: 0 },
      { ...ENTRADA_VALIDA, codigo: "ab" },
      { ...ENTRADA_VALIDA, codigo: "tem espaço" },
      { ...ENTRADA_VALIDA, tipo: "frete" as never },
      { ...ENTRADA_VALIDA, ciclos: ["semanal" as never] },
      { ...ENTRADA_VALIDA, planos: ["PRO!"] },
      { ...ENTRADA_VALIDA, validoAte: "amanhã" },
      { ...ENTRADA_VALIDA, maxUsos: 0 },
      { ...ENTRADA_VALIDA, descricao: "x".repeat(201) },
    ];
    for (const ruim of ruins) {
      expect(await criarCupom(ruim), JSON.stringify(ruim)).toEqual({ ok: false, error: "Dados inválidos." });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("valor fixo aceita centavos acima de 99, e percentual 99 passa", async () => {
    const { criarCupom } = await acoes();
    expect((await criarCupom({ codigo: "DEZ-REAIS", tipo: "valor", valor: 1000 })).ok).toBe(true);
    expect((await criarCupom({ ...ENTRADA_VALIDA, codigo: "P99", valor: 99 })).ok).toBe(true);
  });

  it("os erros do banco viram frases fixas, sem auditoria", async () => {
    const { criarCupom } = await acoes();
    const casos: Array<[string, string]> = [
      ["billing_cupom_codigo_em_uso", "Já existe um cupom com este código."],
      ["billing_cupom_plano_inexistente", "Algum dos planos informados não existe."],
      ["billing_cupom_validade_invalida", "A validade precisa estar no futuro."],
      ["billing_cupom_valor_invalido", "Valor inválido. No percentual, de 1 a 99; em valor fixo, mais que zero."],
    ];
    for (const [codigo, frase] of casos) {
      h.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: codigo } });
      expect(await criarCupom(ENTRADA_VALIDA), codigo).toEqual({ ok: false, error: frase });
    }
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "relation \"billing_cupons\" is locked at 10.0.0.5" } });
    const r = await criarCupom(ENTRADA_VALIDA);
    expect(r).toEqual({ ok: false, error: "Não foi possível salvar. Tente de novo." });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("definirCupomAtivo", () => {
  it("desativa pela função do banco e audita o estado anterior e o novo", async () => {
    const { definirCupomAtivo } = await acoes();
    h.rpc.mockResolvedValue({ data: { id: CUPOM, codigo: "PCT10", ativo_anterior: true, ativo_novo: false }, error: null });

    const r = await definirCupomAtivo({ cupomId: CUPOM, ativo: false });

    expect(r.ok).toBe(true);
    expect(h.rpc).toHaveBeenCalledWith("fn_billing_cupom_definir_ativo", { p_cupom: CUPOM, p_ativo: false, p_actor: USUARIO });
    expect(h.audit.mock.calls[0]?.[0]).toMatchObject({
      action: "billing.coupon_toggled",
      actorUserId: USUARIO,
      resourceId: CUPOM,
      metadata: { codigo: "PCT10", ativo_anterior: true, ativo_novo: false },
    });
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/sistema/cupons");
  });

  it("id que não é UUID e ativo que não é booleano são recusados antes do banco", async () => {
    const { definirCupomAtivo } = await acoes();
    expect((await definirCupomAtivo({ cupomId: "nao-uuid", ativo: true })).ok).toBe(false);
    expect((await definirCupomAtivo({ cupomId: CUPOM, ativo: "sim" as never })).ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("cupom inexistente tem frase própria", async () => {
    const { definirCupomAtivo } = await acoes();
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "billing_cupom_nao_encontrado" } });
    expect(await definirCupomAtivo({ cupomId: CUPOM, ativo: true })).toEqual({ ok: false, error: "Cupom não encontrado." });
  });
});

describe("listarCupons", () => {
  it("devolve a lista do banco, com usos pagos, e não audita (nada muda)", async () => {
    const { listarCupons } = await acoes();
    const linha = { id: CUPOM, codigo: "PCT10", tipo: "percentual", valor: 10, planos: [], ciclos: [], valido_ate: null, max_usos: 5, ativo: true, descricao: null, criado_em: "2026-10-14T12:00:00Z", usos_pagos: 2, usos_abertos: 1 };
    h.rpc.mockResolvedValue({ data: [linha], error: null });

    const r = await listarCupons();

    expect(r).toEqual({ ok: true, cupons: [linha] });
    expect(h.rpc).toHaveBeenCalledWith("fn_billing_cupom_listar");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("lista vazia e erro do banco", async () => {
    const { listarCupons } = await acoes();
    h.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await listarCupons()).toEqual({ ok: true, cupons: [] });
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "segredo interno" } });
    expect(await listarCupons()).toEqual({ ok: false, error: "Não foi possível carregar os cupons." });
  });
});
