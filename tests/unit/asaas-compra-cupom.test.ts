/**
 * Cupom de desconto (migration 0955) em `iniciarCompra`. Nenhuma chamada real: banco e cliente Asaas são
 * dublês em memória. O que se mede:
 *
 *   - o código do cupom (e só ele) vai ao banco; o servidor não manda total quando há cupom;
 *   - assinatura no cartão à vista com cupom: a assinatura nasce no PREÇO CHEIO (renovações) e a primeira
 *     cobrança é rebaixada para o total com desconto ANTES de o link da fatura sair e de a cobrança ser
 *     registrada no pedido;
 *   - se a atualização falhar, a assinatura é removida, o pedido marcado como falho e nenhum link sai;
 *   - cartão parcelado e Pix já são criados com o total descontado, sem atualização;
 *   - os erros de cupom do banco viram frases em pt-BR e o Asaas não é tocado;
 *   - o pedido aberto só é retomado com o mesmo cupom.
 *
 * O CÁLCULO do desconto é do banco e é provado em `tests/invariants/cupons-banco.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  iniciarCompra,
  MENSAGEM_AGUARDE,
  MENSAGEM_CUPOM_ASSINATURA_AGENDADA,
  MENSAGEM_GENERICA,
  MENSAGEM_OUTRA_OFERTA_ABERTA,
  MENSAGEM_TENTE_NOVAMENTE,
  type DbCompra,
  type DepsCompra,
  type EntradaIniciarCompra,
  type PedidoLinha,
} from "@/lib/billing/asaas/compra";
import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import type { AssinaturaAsaas, CobrancaAsaas } from "@/lib/billing/asaas/contratos";
import { erroIndisponivel, erroValidacao } from "@/lib/billing/asaas/erros";

const PRECO_CHEIO = 104900;
const DESCONTO = 10490;
const TOTAL = PRECO_CHEIO - DESCONTO; // 94410
const INSTALLMENT = "7315c152-a55f-4727-aa6c-d48249df28d4";

const CONFIG = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_" + "testeNuncaEUmaChaveReal000111222",
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "",
  ambiente: "sandbox" as const,
};

const ENTRADA: EntradaIniciarCompra = {
  organizationId: "org-1",
  actorId: "actor-1",
  tipo: "assinatura",
  planCode: "pro",
  ciclo: "semiannual",
  metodo: "CREDIT_CARD",
  chave: "11111111-1111-1111-1111-111111111111",
  termosVersao: "2026-09-23",
  cupom: "PCT10",
};

function pedidoComCupom(overrides: Partial<PedidoLinha> = {}): PedidoLinha {
  return {
    id: "pedido-1",
    status: "criado",
    tipo: "assinatura",
    ambiente: "sandbox",
    metodo: "CREDIT_CARD",
    amountCents: TOTAL,
    externalReference: "HC:ord:pedido-1",
    asaasPaymentId: null,
    asaasSubscriptionId: null,
    invoiceUrl: null,
    parcelas: 1,
    asaasInstallmentId: null,
    descontoCents: DESCONTO,
    precoCheioCents: PRECO_CHEIO,
    cupomCodigo: "PCT10",
    ciclo: "semiannual",
    planoNome: "Pro",
    pacoteNome: null,
    planCode: "pro",
    pacoteCode: null,
    atualizadoEm: "2026-10-14T12:00:00Z",
    ...overrides,
  };
}

function cobranca(overrides: Partial<CobrancaAsaas> = {}): CobrancaAsaas {
  const value = overrides.value ?? PRECO_CHEIO / 100;
  return {
    id: "pay_primeira",
    customer: "cus_fake123",
    subscription: "sub_fake123",
    status: "PENDING",
    billingType: "CREDIT_CARD",
    value,
    dueDate: "2026-10-14",
    externalReference: "HC:ord:pedido-1",
    invoiceUrl: "https://sandbox.asaas.com/i/primeira",
    valorConfirmado: value,
    ...overrides,
  } as CobrancaAsaas;
}

function assinatura(): AssinaturaAsaas {
  return {
    id: "sub_fake123",
    customer: "cus_fake123",
    status: "ACTIVE",
    billingType: "CREDIT_CARD",
    cycle: "SEMIANNUALLY",
    value: PRECO_CHEIO / 100,
    externalReference: "HC:ord:pedido-1",
  } as AssinaturaAsaas;
}

/** Banco em memória: o pedido muda como mudaria com as RPCs reais; `ordem` registra a sequência das chamadas. */
function montarBanco(
  pedidoInicial: PedidoLinha,
  ordem: string[],
  opcoes: { erroCriar?: { code: string; message: string }; proximaCobrancaEm?: string | null } = {},
) {
  let pedido = { ...pedidoInicial };
  const db: DbCompra = {
    criarPedido: vi.fn(async () => {
      if (opcoes.erroCriar) return { data: null, error: opcoes.erroCriar };
      return {
        data: {
          pedidoId: pedido.id,
          externalReference: pedido.externalReference,
          amountCents: pedido.amountCents,
          parcelas: pedido.parcelas ?? 1,
          descontoCents: pedido.descontoCents ?? 0,
          jaExistia: false,
          proximaCobrancaEm: opcoes.proximaCobrancaEm ?? null,
        },
        error: null,
      };
    }),
    buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: { ...pedido }, error: null })),
    lerParcelamentoDoPlano: vi.fn(async () => ({
      data: { precoCents: PRECO_CHEIO, parametros: { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 } },
      error: null,
    })),
    registrarParcelamento: vi.fn(async () => ({ data: { jaRegistrado: false }, error: null })),
    tomarPedido: vi.fn(async () => {
      if (pedido.status === "criado" || pedido.status === "inconclusivo") {
        pedido = { ...pedido, status: "processando" };
        return { data: { tomado: true, pedidoId: pedido.id, status: pedido.status }, error: null };
      }
      return { data: { tomado: false, pedidoId: pedido.id, status: pedido.status }, error: null };
    }),
    lerPedido: vi.fn(async () => ({ data: { ...pedido }, error: null })),
    buscarVinculoClienteAsaas: vi.fn(async () => ({ data: { asaasCustomerId: "cus_fake123" }, error: null })),
    vincularClienteAsaas: vi.fn(async (_o, _a, id) => ({ data: { jaExistia: false, asaasCustomerId: id }, error: null })),
    registrarCobranca: vi.fn(async (args) => {
      ordem.push("registrarCobranca");
      pedido = {
        ...pedido,
        asaasPaymentId: args.asaasPaymentId ?? pedido.asaasPaymentId,
        asaasSubscriptionId: args.asaasSubscriptionId ?? pedido.asaasSubscriptionId,
        invoiceUrl: args.invoiceUrl ?? pedido.invoiceUrl,
        status: "aguardando_pagamento",
      };
      return { data: { jaRegistrado: false, pedidoId: pedido.id, status: pedido.status }, error: null };
    }),
    // As regras de fn_billing_pedido_marcar: nunca a partir de pago, e `inconclusivo` só a partir de `processando`.
    marcarPedido: vi.fn(async (_o, _id, status) => {
      ordem.push(`marcar:${status}`);
      if (pedido.status === "pago") return { data: null, error: { code: "22023", message: "billing_pedido_ja_pago" } };
      if (status === "inconclusivo" && pedido.status !== "processando") {
        return { data: null, error: { code: "22023", message: "billing_pedido_nao_esta_processando" } };
      }
      const statusAnterior = pedido.status;
      pedido = { ...pedido, status };
      return { data: { pedidoId: pedido.id, statusAnterior, statusNovo: status }, error: null };
    }),
    lerContrato: vi.fn(async () => ({
      data: { asaasSubscriptionId: null, asaasAssinaturaEncerradaEm: null, currentPeriodEnd: null },
      error: null,
    })),
    marcarAssinaturaEncerrada: vi.fn(async () => ({ data: { jaRegistrado: false, asaasAssinaturaEncerradaEm: "x" }, error: null })),
  };
  return { db, pedido: () => pedido };
}

function montarAsaas(ordem: string[], sobrescritas: Partial<ClienteAsaasHttp> = {}): ClienteAsaasHttp {
  const nao = (nome: string) =>
    vi.fn(async () => {
      throw new Error(`${nome} não deveria ser chamado neste teste`);
    });
  return {
    buscarClientePorReferencia: vi.fn(async () => null),
    criarCliente: nao("criarCliente"),
    atualizarCliente: nao("atualizarCliente"),
    criarAssinatura: vi.fn(async () => {
      ordem.push("criarAssinatura");
      return assinatura();
    }),
    buscarAssinatura: nao("buscarAssinatura"),
    listarCobrancasDaAssinatura: vi.fn(async () => [cobranca()]),
    buscarAssinaturaPorReferencia: vi.fn(async () => null),
    removerAssinatura: vi.fn(async () => {
      ordem.push("removerAssinatura");
    }),
    criarCobranca: vi.fn(async () => {
      ordem.push("criarCobranca");
      return cobranca({ id: "pay_avulso", subscription: null, billingType: "PIX", invoiceUrl: null, value: TOTAL / 100 });
    }),
    buscarCobranca: nao("buscarCobranca"),
    buscarCobrancaPorReferencia: vi.fn(async () => null),
    removerCobranca: vi.fn(async () => undefined),
    atualizarValorDaCobranca: vi.fn(async (id: string, dados: { value: number }) => {
      ordem.push("atualizarValorDaCobranca");
      return cobranca({ id, value: dados.value });
    }),
    criarCobrancaParcelada: vi.fn(async () => {
      ordem.push("criarCobrancaParcelada");
      return cobranca({ id: "pay_parcela1", subscription: null, installment: INSTALLMENT, value: 250 });
    }),
    buscarParcelamento: vi.fn(async () => ({ removido: true as const })),
    removerParcelamento: vi.fn(async () => undefined),
    listarCobrancasDoParcelamento: vi.fn(async () => []),
    qrPix: vi.fn(async () => ({ encodedImage: "img", payload: "000201", expirationDate: null })),
    buscarWebhook: nao("buscarWebhook"),
    ...sobrescritas,
  };
}

function deps(db: DbCompra, asaas: ClienteAsaasHttp) {
  const linhas: Array<{ nivel: string; msg: string; ctx?: Record<string, unknown> }> = [];
  const d: DepsCompra = {
    db,
    asaas,
    config: CONFIG,
    logger: {
      warn: (msg, ctx) => linhas.push({ nivel: "warn", msg, ctx }),
      error: (msg, ctx) => linhas.push({ nivel: "error", msg, ctx }),
    },
  };
  return { d, linhas };
}

describe("cupom: o que vai ao banco", () => {
  it("manda só o código ao banco, sem total, e a assinatura de 1x leva o cupom", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom(), ordem);
    const { d } = deps(db, montarAsaas(ordem));

    await iniciarCompra(d, ENTRADA);

    expect(db.criarPedido).toHaveBeenCalledWith(expect.objectContaining({ cupom: "PCT10", parcelas: 1, totalCents: null }));
  });

  it("parcelado com cupom: o total fica nulo (o desconto é do banco, que calcula os juros sobre o preço descontado)", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom({ parcelas: 4, amountCents: 99000 }), ordem);
    const { d } = deps(db, montarAsaas(ordem));

    await iniciarCompra(d, { ...ENTRADA, parcelas: 4 });

    expect(db.criarPedido).toHaveBeenCalledWith(expect.objectContaining({ cupom: "PCT10", parcelas: 4, totalCents: null }));
  });

  it("parcelado SEM cupom continua mandando o total calculado no servidor", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom({ parcelas: 4, amountCents: 110172, descontoCents: 0, precoCheioCents: null, cupomCodigo: null }), ordem);
    const { d } = deps(db, montarAsaas(ordem));

    await iniciarCompra(d, { ...ENTRADA, cupom: undefined, parcelas: 4 });

    const chamada = vi.mocked(db.criarPedido).mock.calls[0]?.[0];
    expect(chamada?.cupom).toBeNull();
    expect(chamada?.totalCents).toBe(110172);
  });

  it("com cupom e documento, manda ao banco só a IMPRESSÃO (64 hexadecimais), nunca o documento; formatação não muda a impressão", async () => {
    const original = process.env.CPF_ENCRYPTION_KEY;
    process.env.CPF_ENCRYPTION_KEY = "chave-de-teste-do-servidor";
    try {
      const mandado: Array<string | null> = [];
      for (const documento of ["111.444.777-35", "11144477735"]) {
        const ordem: string[] = [];
        const { db } = montarBanco(pedidoComCupom(), ordem);
        const { d } = deps(db, montarAsaas(ordem));
        await iniciarCompra(d, { ...ENTRADA, pagador: { nome: "Fulano de Tal", documento } });
        const args = vi.mocked(db.criarPedido).mock.calls[0]?.[0];
        mandado.push(args?.pagadorImpressao ?? null);
        expect(JSON.stringify(args)).not.toContain("11144477735");
        expect(JSON.stringify(args)).not.toContain("111.444.777-35");
      }
      expect(mandado[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(mandado[1]).toBe(mandado[0]);
    } finally {
      if (original === undefined) delete process.env.CPF_ENCRYPTION_KEY;
      else process.env.CPF_ENCRYPTION_KEY = original;
    }
  });

  it("sem cupom, ou sem documento, nenhuma impressão é mandada", async () => {
    process.env.CPF_ENCRYPTION_KEY = "chave-de-teste-do-servidor";
    try {
      const ordem: string[] = [];
      const { db } = montarBanco(pedidoComCupom({ descontoCents: 0, precoCheioCents: null, cupomCodigo: null, amountCents: PRECO_CHEIO }), ordem);
      const { d } = deps(db, montarAsaas(ordem));
      await iniciarCompra(d, { ...ENTRADA, cupom: undefined, pagador: { nome: "Fulano de Tal", documento: "111.444.777-35" } });
      expect(vi.mocked(db.criarPedido).mock.calls[0]?.[0].pagadorImpressao).toBeNull();

      const ordem2: string[] = [];
      const b2 = montarBanco(pedidoComCupom(), ordem2);
      await iniciarCompra(deps(b2.db, montarAsaas(ordem2)).d, ENTRADA);
      expect(vi.mocked(b2.db.criarPedido).mock.calls[0]?.[0].pagadorImpressao).toBeNull();
    } finally {
      delete process.env.CPF_ENCRYPTION_KEY;
    }
  });

  it("sem cupom, o banco recebe cupom nulo", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom({ descontoCents: 0, precoCheioCents: null, cupomCodigo: null, amountCents: PRECO_CHEIO }), ordem);
    const { d } = deps(db, montarAsaas(ordem));

    await iniciarCompra(d, { ...ENTRADA, cupom: undefined });

    expect(vi.mocked(db.criarPedido).mock.calls[0]?.[0].cupom).toBeNull();
  });
});

describe("cupom: assinatura no cartão à vista (primeira cobrança rebaixada)", () => {
  it("a assinatura nasce no preço cheio, a primeira cobrança vai ao total com desconto, e só depois a cobrança é registrada e o link sai", async () => {
    const ordem: string[] = [];
    const { db, pedido } = montarBanco(pedidoComCupom(), ordem);
    const asaas = montarAsaas(ordem);
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(asaas.criarAssinatura).toHaveBeenCalledWith(expect.objectContaining({ value: PRECO_CHEIO / 100, cycle: "SEMIANNUALLY" }));
    expect(asaas.atualizarValorDaCobranca).toHaveBeenCalledWith("pay_primeira", { value: TOTAL / 100 });
    expect(ordem).toEqual(["criarAssinatura", "atualizarValorDaCobranca", "registrarCobranca"]);
    expect(r).toEqual({
      tipo: "redirecionar",
      url: "https://sandbox.asaas.com/i/primeira",
      cupom: { codigo: "PCT10", descontoCents: DESCONTO },
    });
    expect(pedido().status).toBe("aguardando_pagamento");
    expect(pedido().amountCents).toBe(TOTAL);
  });

  it("com período pago correndo (assinatura agendada), recusa o cupom antes de criar qualquer coisa no Asaas", async () => {
    const ordem: string[] = [];
    const { db, pedido } = montarBanco(pedidoComCupom(), ordem, { proximaCobrancaEm: "2099-01-31" });
    const asaas = montarAsaas(ordem);
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_CUPOM_ASSINATURA_AGENDADA });
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    expect(asaas.atualizarValorDaCobranca).not.toHaveBeenCalled();
    expect(pedido().status).toBe("falhou");
  });

  it("sem cupom, a assinatura agendada segue como antes (nasce para o fim do período pago)", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(
      pedidoComCupom({ descontoCents: 0, precoCheioCents: null, cupomCodigo: null, amountCents: PRECO_CHEIO }),
      ordem,
      { proximaCobrancaEm: "2099-01-31" },
    );
    const asaas = montarAsaas(ordem);
    const { d } = deps(db, asaas);

    await iniciarCompra(d, { ...ENTRADA, cupom: undefined });

    expect(asaas.criarAssinatura).toHaveBeenCalledWith(expect.objectContaining({ nextDueDate: "2099-01-31" }));
  });

  it("mensal tem o mesmo desenho", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom({ ciclo: "monthly", amountCents: 17910, descontoCents: 1990, precoCheioCents: 19900 }), ordem);
    const asaas = montarAsaas(ordem, { listarCobrancasDaAssinatura: vi.fn(async () => [cobranca({ value: 199 })]) });
    const { d } = deps(db, asaas);

    await iniciarCompra(d, { ...ENTRADA, ciclo: "monthly" });

    expect(asaas.criarAssinatura).toHaveBeenCalledWith(expect.objectContaining({ value: 199, cycle: "MONTHLY" }));
    expect(asaas.atualizarValorDaCobranca).toHaveBeenCalledWith("pay_primeira", { value: 179.1 });
  });

  it("sem cupom nada muda: a assinatura nasce no valor do pedido, não há atualização e o resultado não leva cupom", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(
      pedidoComCupom({ descontoCents: 0, precoCheioCents: null, cupomCodigo: null, amountCents: PRECO_CHEIO }),
      ordem,
    );
    const asaas = montarAsaas(ordem);
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, { ...ENTRADA, cupom: undefined });

    expect(asaas.criarAssinatura).toHaveBeenCalledWith(expect.objectContaining({ value: PRECO_CHEIO / 100 }));
    expect(asaas.atualizarValorDaCobranca).not.toHaveBeenCalled();
    expect(r).toEqual({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/primeira" });
  });

  it("falha de validação na atualização: remove a assinatura, marca o pedido como falho, não registra a cobrança e não devolve link", async () => {
    const ordem: string[] = [];
    const { db, pedido } = montarBanco(pedidoComCupom(), ordem);
    const asaas = montarAsaas(ordem, {
      atualizarValorDaCobranca: vi.fn(async () => {
        ordem.push("atualizarValorDaCobranca");
        throw erroValidacao(400, ["invalid_value"]);
      }),
    });
    const { d, linhas } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_GENERICA });
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
    expect(ordem).toEqual(["criarAssinatura", "atualizarValorDaCobranca", "removerAssinatura", "marcar:falhou"]);
    expect(db.registrarCobranca).not.toHaveBeenCalled();
    expect(pedido().status).toBe("falhou");
    expect(linhas.some((l) => l.msg === "asaas_compra_atualizar_primeira_cobranca_falhou")).toBe(true);
  });

  it("timeout na atualização também remove a assinatura (não se sabe se o valor mudou) e marca falho", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom(), ordem);
    const asaas = montarAsaas(ordem, {
      atualizarValorDaCobranca: vi.fn(async () => {
        throw erroIndisponivel(503, true);
      }),
    });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_GENERICA });
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
    expect(ordem).toContain("marcar:falhou");
    expect(db.registrarCobranca).not.toHaveBeenCalled();
  });

  it("se a remoção também falhar, o pedido fica inconclusivo (a conciliação refaz a remoção), nunca falho com assinatura viva", async () => {
    const ordem: string[] = [];
    const { db, pedido } = montarBanco(pedidoComCupom(), ordem);
    const asaas = montarAsaas(ordem, {
      atualizarValorDaCobranca: vi.fn(async () => {
        throw erroValidacao(400, []);
      }),
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(503, false);
      }),
    });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_GENERICA });
    expect(pedido().status).toBe("inconclusivo");
    expect(db.registrarCobranca).not.toHaveBeenCalled();
  });

  it("não conseguir LER a primeira cobrança depois de criar a assinatura com cupom é falha de rebaixamento: remove e marca falho", async () => {
    const ordem: string[] = [];
    const { db, pedido } = montarBanco(pedidoComCupom(), ordem);
    const asaas = montarAsaas(ordem, {
      listarCobrancasDaAssinatura: vi.fn(async () => {
        throw erroIndisponivel(503, false);
      }),
    });
    const { d, linhas } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_GENERICA });
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
    expect(ordem).toEqual(["criarAssinatura", "removerAssinatura", "marcar:falhou"]);
    expect(pedido().status).toBe("falhou");
    expect(db.registrarCobranca).not.toHaveBeenCalled();
    expect(asaas.atualizarValorDaCobranca).not.toHaveBeenCalled();
    expect(linhas.some((l) => l.msg === "asaas_compra_ler_primeira_cobranca_falhou")).toBe(true);
  });

  it("o mesmo erro de leitura SEM cupom continua como antes: registra sem fatura e pede para aguardar", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom({ descontoCents: 0, precoCheioCents: null, cupomCodigo: null, amountCents: PRECO_CHEIO }), ordem);
    const asaas = montarAsaas(ordem, {
      listarCobrancasDaAssinatura: vi.fn(async () => {
        throw erroIndisponivel(503, false);
      }),
    });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, { ...ENTRADA, cupom: undefined });

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
  });

  it("a leitura que falha na recuperação por referência (pedido inconclusivo) também desfaz", async () => {
    const ordem: string[] = [];
    const { db, pedido } = montarBanco(pedidoComCupom({ status: "inconclusivo" }), ordem);
    const asaas = montarAsaas(ordem, {
      buscarAssinaturaPorReferencia: vi.fn(async () => assinatura()),
      listarCobrancasDaAssinatura: vi.fn(async () => {
        throw erroIndisponivel(503, false);
      }),
    });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_GENERICA });
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
    expect(pedido().status).toBe("falhou");
  });

  it("a primeira cobrança é a de MENOR vencimento entre as pendentes, qualquer que seja a ordem da lista", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom(), ordem);
    const proxima = cobranca({ id: "pay_proxima", dueDate: "2027-04-14", invoiceUrl: "https://sandbox.asaas.com/i/proxima" });
    const primeira = cobranca({ id: "pay_primeira", dueDate: "2026-10-14" });
    const asaas = montarAsaas(ordem, { listarCobrancasDaAssinatura: vi.fn(async () => [proxima, primeira]) });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(asaas.atualizarValorDaCobranca).toHaveBeenCalledTimes(1);
    expect(asaas.atualizarValorDaCobranca).toHaveBeenCalledWith("pay_primeira", { value: TOTAL / 100 });
    expect(r).toMatchObject({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/primeira" });
    expect(db.registrarCobranca).toHaveBeenCalledWith(expect.objectContaining({ asaasPaymentId: "pay_primeira" }));
  });

  it("entre duas cobranças, a pendente vence a de vencimento menor que já não está pendente? Não: a pendente é a escolhida", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom(), ordem);
    const velhaPaga = cobranca({ id: "pay_velha", dueDate: "2026-09-14", status: "CONFIRMED" });
    const pendente = cobranca({ id: "pay_pendente", dueDate: "2026-10-14" });
    const asaas = montarAsaas(ordem, { listarCobrancasDaAssinatura: vi.fn(async () => [velhaPaga, pendente]) });
    const { d } = deps(db, asaas);

    await iniciarCompra(d, ENTRADA);

    expect(asaas.atualizarValorDaCobranca).toHaveBeenCalledWith("pay_pendente", { value: TOTAL / 100 });
  });

  it("sem cupom a escolha continua sendo a primeira da lista (o contrato de sempre)", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom({ descontoCents: 0, precoCheioCents: null, cupomCodigo: null, amountCents: PRECO_CHEIO }), ordem);
    const a = cobranca({ id: "pay_a", dueDate: "2027-04-14", invoiceUrl: "https://sandbox.asaas.com/i/a" });
    const b = cobranca({ id: "pay_b", dueDate: "2026-10-14" });
    const asaas = montarAsaas(ordem, { listarCobrancasDaAssinatura: vi.fn(async () => [a, b]) });
    const { d } = deps(db, asaas);

    await iniciarCompra(d, { ...ENTRADA, cupom: undefined });

    expect(db.registrarCobranca).toHaveBeenCalledWith(expect.objectContaining({ asaasPaymentId: "pay_a" }));
  });

  it("primeira cobrança que já não está pendente (paga, vencida) não é alterada nem cancelada: pede para aguardar", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom(), ordem);
    const asaas = montarAsaas(ordem, { listarCobrancasDaAssinatura: vi.fn(async () => [cobranca({ status: "CONFIRMED" })]) });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
    expect(asaas.atualizarValorDaCobranca).not.toHaveBeenCalled();
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
    expect(db.registrarCobranca).not.toHaveBeenCalled();
  });

  it("primeira cobrança que já está no valor certo não é tocada de novo", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom(), ordem);
    const asaas = montarAsaas(ordem, { listarCobrancasDaAssinatura: vi.fn(async () => [cobranca({ value: TOTAL / 100 })]) });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(asaas.atualizarValorDaCobranca).not.toHaveBeenCalled();
    expect(r.tipo).toBe("redirecionar");
  });

  it("sem a primeira cobrança ainda: registra sem fatura e pede para aguardar, sem tocar no valor", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom(), ordem);
    const asaas = montarAsaas(ordem, { listarCobrancasDaAssinatura: vi.fn(async () => []) });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_AGUARDE });
    expect(asaas.atualizarValorDaCobranca).not.toHaveBeenCalled();
  });

  it("retomada de pedido inconclusivo: acha a assinatura pela referência e garante o desconto antes do link", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom({ status: "inconclusivo" }), ordem);
    const asaas = montarAsaas(ordem, { buscarAssinaturaPorReferencia: vi.fn(async () => assinatura()) });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    expect(asaas.atualizarValorDaCobranca).toHaveBeenCalledWith("pay_primeira", { value: TOTAL / 100 });
    expect(r.tipo).toBe("redirecionar");
  });

  it("nova chamada com a cobrança registrada mas sem fatura: reconsulta, garante o desconto e só então devolve o link", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(
      pedidoComCupom({ status: "aguardando_pagamento", asaasSubscriptionId: "sub_fake123", asaasPaymentId: "pay_primeira", invoiceUrl: null }),
      ordem,
    );
    const asaas = montarAsaas(ordem);
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    expect(asaas.atualizarValorDaCobranca).toHaveBeenCalledWith("pay_primeira", { value: TOTAL / 100 });
    expect(r).toMatchObject({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/primeira" });
  });

  it("falha ao garantir o desconto na retomada remove a assinatura e não devolve o link", async () => {
    const ordem: string[] = [];
    const { db, pedido } = montarBanco(
      pedidoComCupom({ status: "aguardando_pagamento", asaasSubscriptionId: "sub_fake123", asaasPaymentId: "pay_primeira", invoiceUrl: null }),
      ordem,
    );
    const asaas = montarAsaas(ordem, {
      atualizarValorDaCobranca: vi.fn(async () => {
        throw erroValidacao(400, []);
      }),
    });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_GENERICA });
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
    expect(pedido().status).toBe("falhou");
  });
});

describe("cupom: retomada (pedido aguardando_pagamento) quando atualizar E remover falham", () => {
  const retomada = () =>
    pedidoComCupom({ status: "aguardando_pagamento", asaasSubscriptionId: "sub_fake123", asaasPaymentId: "pay_primeira", invoiceUrl: null });
  const atualizarFalha = () =>
    vi.fn(async () => {
      throw erroValidacao(400, []);
    });

  it("não tenta marcar inconclusivo (a função real recusa a partir de aguardando_pagamento): loga, deixa o pedido como está e pede para tentar de novo", async () => {
    const ordem: string[] = [];
    const { db, pedido } = montarBanco(retomada(), ordem);
    const asaas = montarAsaas(ordem, {
      atualizarValorDaCobranca: atualizarFalha(),
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(503, false);
      }),
    });
    const { d, linhas } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_TENTE_NOVAMENTE });
    expect(db.marcarPedido).not.toHaveBeenCalled();
    expect(pedido().status).toBe("aguardando_pagamento");
    expect(linhas.some((l) => l.nivel === "error" && l.msg === "asaas_compra_remover_na_retomada_falhou")).toBe(true);
  });

  it("a próxima tentativa refaz a atualização e, dando certo, devolve o link", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(retomada(), ordem);
    const falha = montarAsaas(ordem, {
      atualizarValorDaCobranca: atualizarFalha(),
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(503, false);
      }),
    });
    await iniciarCompra(deps(db, falha).d, ENTRADA);

    const ok = montarAsaas(ordem);
    const r = await iniciarCompra(deps(db, ok).d, ENTRADA);

    expect(ok.atualizarValorDaCobranca).toHaveBeenCalledWith("pay_primeira", { value: TOTAL / 100 });
    expect(r).toMatchObject({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/primeira" });
  });

  it("removendo com sucesso, o pedido vai a falhou (transição que a função real aceita)", async () => {
    const ordem: string[] = [];
    const { db, pedido } = montarBanco(retomada(), ordem);
    const asaas = montarAsaas(ordem, { atualizarValorDaCobranca: atualizarFalha() });
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_GENERICA });
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_fake123");
    expect(pedido().status).toBe("falhou");
  });

  it("o dublê de marcarPedido recusa como a função real (controle do próprio teste)", async () => {
    const { db } = montarBanco(retomada(), []);
    const r = await db.marcarPedido("org-1", "pedido-1", "inconclusivo", "x");
    expect(r.error?.message).toContain("billing_pedido_nao_esta_processando");
  });
});

describe("cupom: cartão parcelado e Pix já nascem com o total descontado", () => {
  it("parcelado: cobrança parcelada com totalValue do pedido (já descontado, com juros), sem atualização", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom({ parcelas: 4, amountCents: 99000 }), ordem);
    const asaas = montarAsaas(ordem);
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, { ...ENTRADA, parcelas: 4 });

    expect(asaas.criarCobrancaParcelada).toHaveBeenCalledWith(expect.objectContaining({ installmentCount: 4, totalValue: 990 }));
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
    expect(asaas.atualizarValorDaCobranca).not.toHaveBeenCalled();
    expect(r).toMatchObject({ tipo: "redirecionar", cupom: { codigo: "PCT10", descontoCents: DESCONTO } });
  });

  it("Pix: cobrança avulsa no total com desconto, sem atualização", async () => {
    const ordem: string[] = [];
    const { db } = montarBanco(pedidoComCupom({ metodo: "PIX" }), ordem);
    const asaas = montarAsaas(ordem);
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, { ...ENTRADA, metodo: "PIX" });

    expect(asaas.criarCobranca).toHaveBeenCalledWith(expect.objectContaining({ billingType: "PIX", value: TOTAL / 100 }));
    expect(asaas.atualizarValorDaCobranca).not.toHaveBeenCalled();
    expect(r).toMatchObject({ tipo: "pix", cupom: { codigo: "PCT10", descontoCents: DESCONTO } });
  });
});

describe("cupom: erros do banco viram frases em pt-BR e o Asaas não é tocado", () => {
  const casos: Array<[string, string]> = [
    ["billing_cupom_invalido", "Cupom inválido ou indisponível para esta compra."],
    ["billing_cupom_expirado", "Cupom inválido ou indisponível para esta compra."],
    ["billing_cupom_esgotado", "Cupom inválido ou indisponível para esta compra."],
    ["billing_cupom_nao_vale_para_o_plano", "Cupom inválido ou indisponível para esta compra."],
    ["billing_cupom_nao_vale_para_o_ciclo", "Cupom inválido ou indisponível para esta compra."],
    ["billing_cupom_ja_usado", "Este cupom já foi utilizado por você ou pela sua organização."],
    ["billing_cupom_sem_desconto", "Este cupom não dá desconto neste plano."],
    ["billing_cupom_parcela_minima", "Com este desconto, escolha menos parcelas."],
  ];

  it("os motivos que não se aplicam a esta compra dão UMA frase só (não revelam se o código existe nem por que não serve)", () => {
    const frasesDeRecusa = new Set(casos.filter(([c]) => !/ja_usado|sem_desconto|parcela_minima/.test(c)).map(([, f]) => f));
    expect(frasesDeRecusa.size).toBe(1);
  });

  for (const [codigo, frase] of casos) {
    it(`${codigo}`, async () => {
      const ordem: string[] = [];
      const { db } = montarBanco(pedidoComCupom(), ordem, { erroCriar: { code: "22023", message: codigo } });
      const asaas = montarAsaas(ordem);
      const { d } = deps(db, asaas);

      const r = await iniciarCompra(d, ENTRADA);

      expect(r).toEqual({ tipo: "erro", mensagem: frase });
      expect(asaas.criarAssinatura).not.toHaveBeenCalled();
      expect(asaas.buscarClientePorReferencia).not.toHaveBeenCalled();
      expect(db.tomarPedido).not.toHaveBeenCalled();
    });
  }
});

describe("cupom: o pedido aberto só é retomado com o mesmo cupom", () => {
  const abertoPorOutraChave = (cupomDoPedido: string | null) => {
    const ordem: string[] = [];
    const { db } = montarBanco(
      pedidoComCupom({ status: "aguardando_pagamento", asaasSubscriptionId: "sub_fake123", asaasPaymentId: "pay_primeira", invoiceUrl: "https://sandbox.asaas.com/i/primeira", cupomCodigo: cupomDoPedido }),
      ordem,
      { erroCriar: { code: "22023", message: "billing_pedido_aberto_existe" } },
    );
    return { db, asaas: montarAsaas(ordem) };
  };

  it("mesmo cupom (sem diferença de maiúsculas) retoma o pedido e devolve o link que já existe", async () => {
    const { db, asaas } = abertoPorOutraChave("PCT10");
    const { d } = deps(db, asaas);

    const r = await iniciarCompra(d, { ...ENTRADA, cupom: "pct10" });

    expect(r).toMatchObject({ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/primeira" });
    expect(asaas.criarAssinatura).not.toHaveBeenCalled();
  });

  it("outro cupom, ou nenhum, é a mensagem de outra oferta aberta", async () => {
    const outro = abertoPorOutraChave("PCT10");
    expect(await iniciarCompra(deps(outro.db, outro.asaas).d, { ...ENTRADA, cupom: "OUTRO20" })).toEqual({ tipo: "erro", mensagem: MENSAGEM_OUTRA_OFERTA_ABERTA });
    const nenhum = abertoPorOutraChave("PCT10");
    expect(await iniciarCompra(deps(nenhum.db, nenhum.asaas).d, { ...ENTRADA, cupom: undefined })).toEqual({ tipo: "erro", mensagem: MENSAGEM_OUTRA_OFERTA_ABERTA });
    const semCupomNoPedido = abertoPorOutraChave(null);
    expect(await iniciarCompra(deps(semCupomNoPedido.db, semCupomNoPedido.asaas).d, ENTRADA)).toEqual({ tipo: "erro", mensagem: MENSAGEM_OUTRA_OFERTA_ABERTA });
  });
});
