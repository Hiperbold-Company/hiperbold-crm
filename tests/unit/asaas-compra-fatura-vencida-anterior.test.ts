/**
 * Cobrança em dobro (migration 1026): a fatura do pedido de assinatura que venceu sem pagar fica no Asaas para a
 * régua de cobrança. Um pedido NOVO de assinatura remove antes essa fatura, senão o cliente poderia pagar as duas.
 *
 * O que se mede: `iniciarCompra` remove no Asaas a fatura dos pedidos vencidos da MESMA organização e ambiente,
 * ANTES de tomar a posse do pedido novo (antes de qualquer cobrança nova); cobrança já paga ou remoção que falha
 * param a compra sem cobrança nova; pacote de tokens não mexe em nada.
 */
import { describe, expect, it, vi } from "vitest";

import {
  iniciarCompra,
  MENSAGEM_GENERICA,
  MENSAGEM_PAGAMENTO_EM_CONFIRMACAO,
  MENSAGEM_TENTE_NOVAMENTE,
  type DbCompra,
  type DepsCompra,
  type EntradaIniciarCompra,
  type PedidoLinha,
} from "@/lib/billing/asaas/compra";
import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import type { CobrancaAsaas } from "@/lib/billing/asaas/contratos";
import { erroIndisponivel, erroNaoEncontrado } from "@/lib/billing/asaas/erros";
import {
  removerFaturaDoPedidoVencido,
  removerFaturasDePedidosVencidos,
  type PedidoVencidoComFatura,
} from "@/lib/billing/asaas/remover-fatura-vencida";

const CONFIG: ConfigAsaas = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_testeNuncaEUmaChaveReal000111222",
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "",
  ambiente: "sandbox",
};

const ENTRADA: EntradaIniciarCompra = {
  organizationId: "org-1",
  actorId: "actor-1",
  tipo: "assinatura",
  planCode: "pro",
  ciclo: "monthly",
  metodo: "CREDIT_CARD",
  chave: "11111111-1111-1111-1111-111111111111",
  termosVersao: "2026-09-23",
};

function pedidoNovo(overrides: Partial<PedidoLinha> = {}): PedidoLinha {
  return {
    id: "pedido-novo",
    status: "criado",
    tipo: "assinatura",
    ambiente: "sandbox",
    metodo: "CREDIT_CARD",
    amountCents: 19900,
    externalReference: "HC:ord:pedido-novo",
    asaasPaymentId: null,
    asaasSubscriptionId: null,
    invoiceUrl: null,
    ciclo: "monthly",
    planoNome: "Pro",
    pacoteNome: null,
    planCode: "pro",
    pacoteCode: null,
    atualizadoEm: "2026-11-26T12:00:00Z",
    ...overrides,
  };
}

function cobranca(overrides: Partial<CobrancaAsaas> = {}): CobrancaAsaas {
  return {
    id: "pay_antigo",
    customer: "cus_1",
    status: "OVERDUE",
    billingType: "CREDIT_CARD",
    value: 199,
    dueDate: "2026-11-13",
    externalReference: "HC:ord:pedido-antigo",
    invoiceUrl: "https://sandbox.asaas.com/i/antigo",
    valorConfirmado: 199,
    ...overrides,
  };
}

function asaasFalso(overrides: Partial<ClienteAsaasHttp> = {}): ClienteAsaasHttp {
  const nunca = (nome: string) =>
    vi.fn(async () => {
      throw new Error(`${nome} não deveria ser chamado`);
    });
  return {
    buscarClientePorReferencia: nunca("buscarClientePorReferencia"),
    criarCliente: nunca("criarCliente"),
    atualizarCliente: nunca("atualizarCliente"),
    criarAssinatura: nunca("criarAssinatura"),
    buscarAssinatura: nunca("buscarAssinatura"),
    listarCobrancasDaAssinatura: vi.fn(async () => [cobranca()]),
    buscarAssinaturaPorReferencia: nunca("buscarAssinaturaPorReferencia"),
    removerAssinatura: vi.fn(async () => undefined),
    criarCobranca: nunca("criarCobranca"),
    buscarCobranca: vi.fn(async () => cobranca()),
    buscarCobrancaPorReferencia: nunca("buscarCobrancaPorReferencia"),
    removerCobranca: vi.fn(async () => undefined),
    atualizarValorDaCobranca: nunca("atualizarValorDaCobranca"),
    criarCobrancaParcelada: nunca("criarCobrancaParcelada"),
    buscarParcelamento: nunca("buscarParcelamento"),
    removerParcelamento: vi.fn(async () => undefined),
    listarCobrancasDoParcelamento: vi.fn(async () => [] as CobrancaAsaas[]),
    qrPix: nunca("qrPix"),
    buscarWebhook: nunca("buscarWebhook"),
    ...overrides,
  } as ClienteAsaasHttp;
}

/**
 * Banco falso: o pedido novo nasce `criado`; `tomarPedido` devolve erro de propósito, para a compra parar logo
 * depois do ponto medido (a remoção acontece ANTES da posse) sem precisar dublar o resto do fluxo.
 */
function dbFalso(pedido: PedidoLinha, vencidos: PedidoVencidoComFatura[]) {
  const db = {
    criarPedido: vi.fn(async () => ({
      data: { pedidoId: pedido.id, externalReference: pedido.externalReference, amountCents: pedido.amountCents, jaExistia: false, proximaCobrancaEm: null },
      error: null,
    })),
    lerPedido: vi.fn(async () => ({ data: { ...pedido }, error: null })),
    listarPedidosDeAssinaturaVencidos: vi.fn(async () => ({ data: vencidos, error: null })),
    tomarPedido: vi.fn(async () => ({ data: null, error: { code: "XX000", message: "parada do teste" } })),
  } as unknown as DbCompra;
  return db;
}

function deps(db: DbCompra, asaas: ClienteAsaasHttp): DepsCompra {
  return { db, asaas, config: CONFIG, logger: { warn: () => undefined, error: () => undefined } };
}

const VENCIDO_CARTAO: PedidoVencidoComFatura = {
  id: "pedido-antigo",
  asaasPaymentId: "pay_antigo",
  asaasSubscriptionId: "sub_antigo",
  asaasInstallmentId: null,
};

describe("iniciarCompra: pedido novo de assinatura remove a fatura do pedido vencido anterior (1026)", () => {
  it("remove a assinatura do pedido vencido, da mesma organização e ambiente, ANTES de tomar o pedido novo", async () => {
    const db = dbFalso(pedidoNovo(), [VENCIDO_CARTAO]);
    const asaas = asaasFalso();
    const r = await iniciarCompra(deps(db, asaas), ENTRADA);

    expect(db.listarPedidosDeAssinaturaVencidos).toHaveBeenCalledWith("org-1", "sandbox");
    // Confere TODAS as cobranças da assinatura (a do id gravado já vem na lista: sem GET avulso).
    expect(asaas.listarCobrancasDaAssinatura).toHaveBeenCalledWith("sub_antigo");
    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_antigo");
    expect(asaas.removerCobranca).not.toHaveBeenCalled();
    const ordemRemocao = vi.mocked(asaas.removerAssinatura).mock.invocationCallOrder[0]!;
    const ordemPosse = vi.mocked(db.tomarPedido).mock.invocationCallOrder[0]!;
    expect(ordemRemocao).toBeLessThan(ordemPosse);
    // A parada do teste (tomarPedido com erro), não uma recusa da remoção.
    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_GENERICA });
  });

  it("cobrança antiga já paga (o evento ainda não chegou): não remove, não toma o pedido novo, pede para aguardar", async () => {
    const db = dbFalso(pedidoNovo(), [VENCIDO_CARTAO]);
    const asaas = asaasFalso({ listarCobrancasDaAssinatura: vi.fn(async () => [cobranca({ status: "CONFIRMED" })]) });
    const r = await iniciarCompra(deps(db, asaas), ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_PAGAMENTO_EM_CONFIRMACAO });
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
    expect(db.tomarPedido).not.toHaveBeenCalled();
  });

  it("a cobrança paga é OUTRA da assinatura (não a do id gravado): também não remove", async () => {
    const db = dbFalso(pedidoNovo(), [VENCIDO_CARTAO]);
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => [cobranca(), cobranca({ id: "pay_segunda", status: "RECEIVED" })]),
    });
    const r = await iniciarCompra(deps(db, asaas), ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_PAGAMENTO_EM_CONFIRMACAO });
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
    expect(db.tomarPedido).not.toHaveBeenCalled();
  });

  it("cartão em análise antifraude conta como pago: não remove, pede para aguardar", async () => {
    const db = dbFalso(pedidoNovo(), [VENCIDO_CARTAO]);
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => [cobranca({ status: "AWAITING_RISK_ANALYSIS" })]),
    });
    const r = await iniciarCompra(deps(db, asaas), ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_PAGAMENTO_EM_CONFIRMACAO });
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
  });

  it("remoção que falha porque o pagamento entrou no meio: reconfere e pede para aguardar", async () => {
    const db = dbFalso(pedidoNovo(), [VENCIDO_CARTAO]);
    const listar = vi
      .fn<ClienteAsaasHttp["listarCobrancasDaAssinatura"]>()
      .mockResolvedValueOnce([cobranca()])
      .mockResolvedValueOnce([cobranca({ status: "CONFIRMED" })]);
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: listar,
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(400);
      }),
    });
    const r = await iniciarCompra(deps(db, asaas), ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_PAGAMENTO_EM_CONFIRMACAO });
    expect(listar).toHaveBeenCalledTimes(2);
    expect(db.tomarPedido).not.toHaveBeenCalled();
  });

  it("remoção que falha no Asaas: a compra nova não segue (nenhuma cobrança nova)", async () => {
    const db = dbFalso(pedidoNovo(), [VENCIDO_CARTAO]);
    const asaas = asaasFalso({
      removerAssinatura: vi.fn(async () => {
        throw erroIndisponivel(503);
      }),
    });
    const r = await iniciarCompra(deps(db, asaas), ENTRADA);

    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_TENTE_NOVAMENTE });
    expect(db.tomarPedido).not.toHaveBeenCalled();
  });

  it("pacote de tokens não procura nem remove pedido de assinatura vencido", async () => {
    const db = dbFalso(pedidoNovo({ tipo: "pacote_tokens", ciclo: null, planCode: null, pacoteCode: "mil" }), [VENCIDO_CARTAO]);
    const asaas = asaasFalso();
    await iniciarCompra(deps(db, asaas), { ...ENTRADA, tipo: "pacote_tokens", planCode: undefined, ciclo: undefined, pacote: "mil" });

    expect(db.listarPedidosDeAssinaturaVencidos).not.toHaveBeenCalled();
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
    expect(asaas.removerCobranca).not.toHaveBeenCalled();
  });
});

describe("removerFaturasDePedidosVencidos", () => {
  const logger = { warn: () => undefined };

  it("Pix (sem assinatura) remove a cobrança; parcelado remove o parcelamento inteiro", async () => {
    const asaas = asaasFalso({
      buscarCobranca: vi.fn(async () => cobranca({ id: "pay_pix", status: "PENDING" })),
      listarCobrancasDoParcelamento: vi.fn(async () => [cobranca({ id: "pay_p1", status: "OVERDUE" })]),
    });
    const r = await removerFaturasDePedidosVencidos(
      asaas,
      [
        { id: "pix", asaasPaymentId: "pay_pix", asaasSubscriptionId: null, asaasInstallmentId: null },
        { id: "parc", asaasPaymentId: "pay_p1", asaasSubscriptionId: null, asaasInstallmentId: "inst-1" },
      ],
      logger,
    );
    expect(r).toBe("ok");
    expect(asaas.removerCobranca).toHaveBeenCalledWith("pay_pix");
    expect(asaas.removerParcelamento).toHaveBeenCalledWith("inst-1");
    expect(asaas.removerCobranca).toHaveBeenCalledTimes(1);
  });

  it("parcelado com UMA parcela paga: não remove o parcelamento", async () => {
    const asaas = asaasFalso({
      listarCobrancasDoParcelamento: vi.fn(async () => [
        cobranca({ id: "pay_p1", status: "OVERDUE" }),
        cobranca({ id: "pay_p2", status: "RECEIVED" }),
      ]),
    });
    const r = await removerFaturaDoPedidoVencido(
      asaas,
      { id: "parc", asaasPaymentId: "pay_p1", asaasSubscriptionId: null, asaasInstallmentId: "inst-1" },
      logger,
    );
    expect(r).toMatchObject({ desfecho: "pago", cobranca: { id: "pay_p2" } });
    expect(asaas.removerParcelamento).not.toHaveBeenCalled();
  });

  it("cobrança que já não existe no Asaas ainda remove a assinatura (idempotente)", async () => {
    const asaas = asaasFalso({ listarCobrancasDaAssinatura: vi.fn(async () => [] as CobrancaAsaas[]), buscarCobranca: vi.fn(async () => ({ removido: true as const })) });
    expect(await removerFaturasDePedidosVencidos(asaas, [VENCIDO_CARTAO], logger)).toBe("ok");
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_antigo");
  });

  it("assinatura que já saiu do Asaas (a lista dá 404): conta como removida, sem falha", async () => {
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => {
        throw erroNaoEncontrado(404);
      }),
      buscarCobranca: vi.fn(async () => ({ removido: true as const })),
    });
    expect(await removerFaturasDePedidosVencidos(asaas, [VENCIDO_CARTAO], logger)).toBe("ok");
    expect(asaas.removerAssinatura).toHaveBeenCalledWith("sub_antigo");
  });

  it("falha de rede ao conferir: não remove às cegas", async () => {
    const asaas = asaasFalso({
      listarCobrancasDaAssinatura: vi.fn(async () => {
        throw erroIndisponivel(503);
      }),
    });
    expect(await removerFaturasDePedidosVencidos(asaas, [VENCIDO_CARTAO], logger)).toBe("falhou");
    expect(asaas.removerAssinatura).not.toHaveBeenCalled();
  });

  it("sem pedido vencido, não chama o Asaas", async () => {
    const asaas = asaasFalso();
    expect(await removerFaturasDePedidosVencidos(asaas, [], logger)).toBe("ok");
    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
  });
});
