/**
 * Retorno automático do cartão (`callback: { successUrl, autoRedirect }`, 15/10/2026): depois de pagar na
 * fatura hospedada o Asaas devolve o cliente ao app. Nenhuma chamada real: banco e fetch são dublês.
 *
 * Mede o CORPO que sai para o Asaas (cliente HTTP real, fetch falso) e o comportamento de `iniciarCompra`:
 *  - cartão (assinatura 1x, parcelado, avulso) leva o callback; Pix nunca;
 *  - sem URL de retorno nas dependências, o corpo é o de sempre (sem a chave `callback`);
 *  - se o Asaas recusar por validação (domínio do retorno não cadastrado na conta), repete UMA vez sem o
 *    retorno e a compra segue; outro erro não é repetido.
 *
 * Comando: npx vitest run tests/unit/asaas-compra-retorno-do-cartao.test.ts
 */
import { describe, expect, it, vi } from "vitest";

import { criarClienteAsaas, type FetchAsaas } from "@/lib/billing/asaas/cliente";
import {
  iniciarCompra,
  MENSAGEM_VALIDACAO,
  type DbCompra,
  type DepsCompra,
  type EntradaIniciarCompra,
  type PedidoLinha,
} from "@/lib/billing/asaas/compra";
import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import { callbackAsaasSchema, type CobrancaAsaas } from "@/lib/billing/asaas/contratos";
import { erroValidacao, ErroAsaasException } from "@/lib/billing/asaas/erros";

const RETORNO = "https://crm.hiperbold.com.br/voltar-do-pagamento?para=onboarding";
const CALLBACK = { successUrl: RETORNO, autoRedirect: true };

const CONFIG: ConfigAsaas = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_" + "testeNuncaEUmaChaveReal000111222",
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "",
  ambiente: "sandbox",
};

// ─── O corpo que o cliente HTTP real manda ──────────────────────────────────

function clienteComFetchFalso(corpoDaResposta: unknown) {
  const chamadas: Array<{ url: string; corpo: Record<string, unknown> }> = [];
  const fetchFalso = (async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), corpo: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(corpoDaResposta), { status: 200, headers: { "content-type": "application/json" } });
  }) as FetchAsaas;
  const cliente = criarClienteAsaas({ fetch: fetchFalso, config: CONFIG, logger: { warn: vi.fn(), error: vi.fn() } });
  return { cliente, chamadas };
}

describe("corpo do POST no Asaas", () => {
  it("assinatura: o callback vai no corpo de POST /subscriptions", async () => {
    const { cliente, chamadas } = clienteComFetchFalso({
      id: "sub_abc123",
      customer: "cus_abc123",
      status: "ACTIVE",
      billingType: "CREDIT_CARD",
      cycle: "MONTHLY",
      value: 199,
    });
    await cliente.criarAssinatura({
      customer: "cus_abc123",
      billingType: "CREDIT_CARD",
      value: 199,
      nextDueDate: "2026-10-15",
      cycle: "MONTHLY",
      callback: CALLBACK,
    });
    expect(chamadas[0]!.url).toMatch(/\/subscriptions$/);
    expect(chamadas[0]!.corpo.callback).toEqual(CALLBACK);
  });

  it("cobrança avulsa e parcelada: o callback vai no corpo de POST /payments", async () => {
    const resposta = {
      id: "pay_abc123",
      customer: "cus_abc123",
      status: "PENDING",
      billingType: "CREDIT_CARD",
      value: 100,
      dueDate: "2026-10-16",
    };
    const { cliente, chamadas } = clienteComFetchFalso(resposta);
    await cliente.criarCobranca({
      customer: "cus_abc123",
      billingType: "CREDIT_CARD",
      value: 100,
      dueDate: "2026-10-16",
      callback: CALLBACK,
    });
    await cliente.criarCobrancaParcelada({
      customer: "cus_abc123",
      billingType: "CREDIT_CARD",
      installmentCount: 4,
      totalValue: 400,
      dueDate: "2026-10-15",
      callback: CALLBACK,
    });
    expect(chamadas.map((c) => c.url.replace(/^.*\/v3/, ""))).toEqual(["/payments", "/payments"]);
    expect(chamadas[0]!.corpo.callback).toEqual(CALLBACK);
    expect(chamadas[1]!.corpo.callback).toEqual(CALLBACK);
  });

  it("sem callback o corpo é o de sempre: a chave nem existe", async () => {
    const { cliente, chamadas } = clienteComFetchFalso({
      id: "pay_abc123",
      customer: "cus_abc123",
      status: "PENDING",
      billingType: "PIX",
      value: 100,
      dueDate: "2026-10-16",
    });
    await cliente.criarCobranca({ customer: "cus_abc123", billingType: "PIX", value: 100, dueDate: "2026-10-16" });
    expect("callback" in chamadas[0]!.corpo).toBe(false);
  });

  it("successUrl que não é URL, ou passa de 255 caracteres, é recusado antes de chamar o Asaas", async () => {
    expect(callbackAsaasSchema.safeParse({ successUrl: "/voltar-do-pagamento?para=onboarding" }).success).toBe(false);
    expect(callbackAsaasSchema.safeParse({ successUrl: `https://x.com/${"a".repeat(250)}` }).success).toBe(false);
    expect(callbackAsaasSchema.safeParse({ successUrl: RETORNO, autoRedirect: true }).success).toBe(true);
  });
});

// ─── iniciarCompra ──────────────────────────────────────────────────────────

function pedidoBase(sobre: Partial<PedidoLinha>): PedidoLinha {
  return {
    id: "pedido-1",
    status: "criado",
    tipo: "assinatura",
    ambiente: "sandbox",
    metodo: "CREDIT_CARD",
    amountCents: 19900,
    externalReference: "HC:ord:pedido-1",
    asaasPaymentId: null,
    asaasSubscriptionId: null,
    invoiceUrl: null,
    parcelas: 1,
    asaasInstallmentId: null,
    ciclo: "monthly",
    planoNome: "Pro",
    pacoteNome: null,
    planCode: "pro",
    pacoteCode: null,
    atualizadoEm: "2026-10-15T12:00:00Z",
    ...sobre,
  };
}

const cobranca = (sobre: Partial<CobrancaAsaas> = {}): CobrancaAsaas =>
  ({
    id: "pay_fake1",
    customer: "cus_fake123",
    status: "PENDING",
    billingType: "CREDIT_CARD",
    value: 199,
    dueDate: "2026-10-15",
    externalReference: "HC:ord:pedido-1",
    invoiceUrl: "https://sandbox.asaas.com/i/fake1",
    valorConfirmado: 199,
    ...sobre,
  }) as CobrancaAsaas;

function montar(pedidoInicial: Partial<PedidoLinha>, urlDeRetornoDoCartao?: string) {
  let pedido = pedidoBase(pedidoInicial);
  const db: DbCompra = {
    criarPedido: vi.fn(async () => ({
      data: {
        pedidoId: pedido.id,
        externalReference: pedido.externalReference,
        amountCents: pedido.amountCents,
        parcelas: pedido.parcelas ?? 1,
        jaExistia: false,
        proximaCobrancaEm: null,
      },
      error: null,
    })),
    lerParcelamentoDoPlano: vi.fn(async () => ({
      data: { precoCents: 104900, parametros: { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 } },
      error: null,
    })),
    registrarParcelamento: vi.fn(async () => ({ data: { jaRegistrado: false }, error: null })),
    buscarPedidoAbertoPorTipo: vi.fn(async () => ({ data: null, error: null })),
    tomarPedido: vi.fn(async () => {
      pedido = { ...pedido, status: "processando" };
      return { data: { tomado: true, pedidoId: pedido.id, status: pedido.status }, error: null };
    }),
    lerPedido: vi.fn(async () => ({ data: { ...pedido }, error: null })),
    buscarVinculoClienteAsaas: vi.fn(async () => ({ data: { asaasCustomerId: "cus_fake123" }, error: null })),
    vincularClienteAsaas: vi.fn(),
    registrarCobranca: vi.fn(async (args) => {
      pedido = { ...pedido, status: "aguardando_pagamento", invoiceUrl: args.invoiceUrl };
      return { data: { jaRegistrado: false, pedidoId: pedido.id, status: pedido.status }, error: null };
    }),
    marcarPedido: vi.fn(async () => ({ data: null, error: null })),
    lerContrato: vi.fn(async () => ({ data: null, error: null })),
    cancelarNoFimDoPeriodo: vi.fn(),
    marcarAssinaturaEncerrada: vi.fn(),
  };
  const asaas = {
    criarAssinatura: vi.fn(async (_dados: Record<string, unknown>) => ({
      id: "sub_fake123",
      customer: "cus_fake123",
      status: "ACTIVE",
      billingType: "CREDIT_CARD",
      cycle: "MONTHLY",
      value: 199,
    })),
    listarCobrancasDaAssinatura: vi.fn(async () => [cobranca()]),
    criarCobrancaParcelada: vi.fn(async (_dados: Record<string, unknown>) => cobranca({ installment: "7315c152-a55f-4727-aa6c-d48249df28d4" })),
    criarCobranca: vi.fn(async (_dados: Record<string, unknown>) => cobranca()),
    buscarQrCodePix: vi.fn(async () => ({ encodedImage: "x", payload: "y", expirationDate: null })),
    removerAssinatura: vi.fn(async () => undefined),
    removerCobranca: vi.fn(async () => undefined),
  };
  const deps: DepsCompra = {
    db,
    asaas: asaas as unknown as DepsCompra["asaas"],
    config: CONFIG,
    logger: { warn: vi.fn(), error: vi.fn() },
    agora: () => new Date("2026-10-15T15:00:00Z"),
    ...(urlDeRetornoDoCartao ? { urlDeRetornoDoCartao } : {}),
  };
  return { db, asaas, deps };
}

const entrada = (sobre: Partial<EntradaIniciarCompra> = {}): EntradaIniciarCompra => ({
  organizationId: "org-1",
  actorId: "user-1",
  tipo: "assinatura",
  planCode: "pro",
  ciclo: "monthly",
  metodo: "CREDIT_CARD",
  chave: "chave-1",
  termosVersao: "2026-09-23",
  ...sobre,
});

describe("iniciarCompra com o retorno do cartão", () => {
  it("assinatura no cartão (1x): o callback vai na criação da assinatura", async () => {
    const { asaas, deps } = montar({}, RETORNO);
    const r = await iniciarCompra(deps, entrada());
    expect(r.tipo).toBe("redirecionar");
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1);
    expect(asaas.criarAssinatura).toHaveBeenCalledWith(expect.objectContaining({ callback: CALLBACK }));
  });

  it("cartão parcelado: o callback vai na cobrança parcelada", async () => {
    const { asaas, deps } = montar({ parcelas: 4, amountCents: 110172, ciclo: "semiannual" }, RETORNO);
    await iniciarCompra(deps, entrada({ parcelas: 4, ciclo: "semiannual" }));
    expect(asaas.criarCobrancaParcelada).toHaveBeenCalledWith(expect.objectContaining({ callback: CALLBACK }));
  });

  it("Pix nunca leva o callback: o Pix se paga no app do banco", async () => {
    const { asaas, deps } = montar({ metodo: "PIX" }, RETORNO);
    await iniciarCompra(deps, entrada({ metodo: "PIX" }));
    expect(asaas.criarCobranca).toHaveBeenCalledTimes(1);
    const corpo = asaas.criarCobranca.mock.calls[0]![0];
    expect("callback" in corpo).toBe(false);
  });

  it("sem URL de retorno nas dependências o corpo é o de sempre (a chave callback não existe)", async () => {
    const { asaas, deps } = montar({});
    await iniciarCompra(deps, entrada());
    const corpo = asaas.criarAssinatura.mock.calls[0]![0];
    expect("callback" in corpo).toBe(false);
  });

  it("Asaas recusa o retorno por validação (domínio não cadastrado): repete UMA vez sem ele e a compra segue", async () => {
    const { asaas, deps, db } = montar({}, RETORNO);
    asaas.criarAssinatura.mockRejectedValueOnce(erroValidacao(400, ["invalid_callback"]));
    const r = await iniciarCompra(deps, entrada());
    expect(r.tipo).toBe("redirecionar");
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(2);
    expect(asaas.criarAssinatura.mock.calls[0]![0]).toHaveProperty("callback");
    expect(asaas.criarAssinatura.mock.calls[1]![0]).not.toHaveProperty("callback");
    expect(db.marcarPedido).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "falhou", expect.anything());
  });

  it("recusa por validação que persiste sem o retorno é falha definitiva, como antes", async () => {
    const { asaas, deps } = montar({}, RETORNO);
    asaas.criarAssinatura.mockRejectedValue(erroValidacao(400, ["invalid_object"]));
    const r = await iniciarCompra(deps, entrada());
    expect(r).toEqual({ tipo: "erro", mensagem: MENSAGEM_VALIDACAO });
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(2);
  });

  it("outro erro (5xx, timeout) NÃO é repetido: repetir um POST financeiro às cegas duplicaria cobrança", async () => {
    const { asaas, deps } = montar({}, RETORNO);
    asaas.criarAssinatura.mockRejectedValue(
      new ErroAsaasException({ tipo: "indisponivel", status: 503, inconclusivo: true }),
    );
    const r = await iniciarCompra(deps, entrada());
    expect(r.tipo).toBe("erro");
    expect(asaas.criarAssinatura).toHaveBeenCalledTimes(1);
  });
});
