/**
 * A remoção, no Asaas, da fatura de um pedido que venceu sem pagar (régua de cobrança, migration 1026). Dois
 * chamadores, a mesma conferência:
 *
 *  - `iniciarCompra` (`compra.ts`): cobrança em dobro. A fatura de um pedido de assinatura vencido continua no
 *    Asaas até o prazo da régua; se o cliente faz um pedido NOVO nesse meio-tempo, a antiga sai ANTES de a nova
 *    ser criada, senão ele poderia pagar as duas;
 *  - o passo 3 da conciliação (`conciliar.ts`), no prazo de `fn_billing_pedidos_vencidos_para_remocao`.
 *
 * Antes de remover, a mesma conferência de `cancelarPedidoAbertoDoCliente` (`compra.ts`): lista TODAS as cobranças
 * da assinatura e do parcelamento do pedido (e a avulsa pelo id), sem depender só do `asaasPaymentId`. Qualquer
 * cobrança confirmada, recebida ou em análise antifraude (`AWAITING_RISK_ANALYSIS`) conta como dinheiro entrando:
 * nada é removido e quem chamou recebe a cobrança paga (o evento dela vai liberar o acesso). Remoção que falhou
 * reconfere: o Asaas recusa remover cobrança paga, e o pagamento pode ter entrado no meio. Nunca lança.
 */
import type { ClienteAsaasHttp } from "./cliente";
import type { CobrancaAsaas } from "./contratos";
import { ErroAsaasException } from "./erros";

/** Um pedido vencido, com o que o Asaas tem dele. */
export interface PedidoVencidoComFatura {
  id: string;
  asaasPaymentId: string | null;
  asaasSubscriptionId: string | null;
  asaasInstallmentId: string | null;
}

export type DesfechoDaRemocaoAnterior = "ok" | "pago" | "falhou";

export type ResultadoDaRemocaoDoPedido =
  | { desfecho: "removido" }
  | { desfecho: "pago"; cobranca: CobrancaAsaas }
  | { desfecho: "falhou"; erro: unknown };

/** Dinheiro entrando: os três status pagos e o cartão em análise antifraude (o mesmo conjunto de `compra.ts`). */
export const STATUS_PAGO_OU_EM_ANALISE = new Set(["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH", "AWAITING_RISK_ANALYSIS"]);

interface LoggerDaRemocao {
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

function tipoDoErro(err: unknown): string {
  return err instanceof ErroAsaasException ? err.erro.tipo : "desconhecido";
}

/** A lista do Asaas, com 404 (assinatura ou parcelamento que já saiu) valendo lista vazia: a remoção é idempotente. */
async function listaOuVazia(ler: () => Promise<CobrancaAsaas[]>): Promise<CobrancaAsaas[]> {
  try {
    return await ler();
  } catch (err) {
    if (err instanceof ErroAsaasException && err.erro.tipo === "nao_encontrado") return [];
    throw err;
  }
}

/**
 * Todas as cobranças que o Asaas tem do pedido: da assinatura, do parcelamento e a avulsa, pelos ids gravados.
 * Diferente de `cancelarPedidoAbertoDoCliente`, não procura pela `externalReference`: o pedido vencido já passou
 * pelo POST e pelo registro (o vencimento veio de um evento do Asaas sobre o id gravado).
 */
async function lerCobrancasDoPedido(asaas: ClienteAsaasHttp, pedido: PedidoVencidoComFatura): Promise<CobrancaAsaas[]> {
  const cobrancas = new Map<string, CobrancaAsaas>();
  const assinatura = pedido.asaasSubscriptionId;
  const parcelamento = pedido.asaasInstallmentId;
  if (assinatura) {
    for (const c of await listaOuVazia(() => asaas.listarCobrancasDaAssinatura(assinatura))) cobrancas.set(c.id, c);
  }
  if (parcelamento) {
    for (const c of await listaOuVazia(() => asaas.listarCobrancasDoParcelamento(parcelamento))) cobrancas.set(c.id, c);
  }
  if (pedido.asaasPaymentId && !cobrancas.has(pedido.asaasPaymentId)) {
    const c = await asaas.buscarCobranca(pedido.asaasPaymentId);
    if (!("removido" in c)) cobrancas.set(c.id, c);
  }
  return [...cobrancas.values()];
}

function cobrancaPaga(cobrancas: CobrancaAsaas[]): CobrancaAsaas | null {
  return cobrancas.find((c) => STATUS_PAGO_OU_EM_ANALISE.has(c.status)) ?? null;
}

/** Remove a fatura de UM pedido vencido, depois de conferir que nenhuma cobrança dele foi paga. */
export async function removerFaturaDoPedidoVencido(
  asaas: ClienteAsaasHttp,
  pedido: PedidoVencidoComFatura,
  logger: LoggerDaRemocao,
): Promise<ResultadoDaRemocaoDoPedido> {
  if (!pedido.asaasPaymentId && !pedido.asaasSubscriptionId && !pedido.asaasInstallmentId) return { desfecho: "removido" };

  try {
    const paga = cobrancaPaga(await lerCobrancasDoPedido(asaas, pedido));
    if (paga) return { desfecho: "pago", cobranca: paga };
  } catch (erro) {
    logger.warn("asaas_remover_fatura_vencida_conferir_falhou", { pedidoId: pedido.id, tipoErro: tipoDoErro(erro) });
    return { desfecho: "falhou", erro };
  }

  try {
    if (pedido.asaasSubscriptionId) await asaas.removerAssinatura(pedido.asaasSubscriptionId);
    if (pedido.asaasInstallmentId) await asaas.removerParcelamento(pedido.asaasInstallmentId);
    if (!pedido.asaasSubscriptionId && !pedido.asaasInstallmentId && pedido.asaasPaymentId) {
      await asaas.removerCobranca(pedido.asaasPaymentId);
    }
  } catch (erro) {
    logger.warn("asaas_remover_fatura_vencida_falhou", { pedidoId: pedido.id, tipoErro: tipoDoErro(erro) });
    // O Asaas recusa remover cobrança já paga: reconfere antes de dizer que falhou.
    try {
      const paga = cobrancaPaga(await lerCobrancasDoPedido(asaas, pedido));
      if (paga) return { desfecho: "pago", cobranca: paga };
    } catch {
      // sem a reconferência, vale a falha.
    }
    return { desfecho: "falhou", erro };
  }
  return { desfecho: "removido" };
}

/**
 * Remove a fatura de cada pedido vencido. `ok` = todas removidas (ou já não existiam); `pago` = alguma já foi
 * paga ou está em análise (a compra nova deve esperar); `falhou` = alguma não saiu (a compra nova não segue agora).
 */
export async function removerFaturasDePedidosVencidos(
  asaas: ClienteAsaasHttp,
  pedidos: readonly PedidoVencidoComFatura[],
  logger: LoggerDaRemocao,
): Promise<DesfechoDaRemocaoAnterior> {
  for (const pedido of pedidos) {
    const r = await removerFaturaDoPedidoVencido(asaas, pedido, logger);
    if (r.desfecho === "pago") return "pago";
    if (r.desfecho === "falhou") return "falhou";
  }
  return "ok";
}
