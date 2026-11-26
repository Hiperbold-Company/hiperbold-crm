/**
 * Cobrança em dobro (régua de cobrança, migration 1026): a fatura de um pedido de assinatura que venceu sem pagar
 * continua no Asaas até o prazo da régua (`fn_billing_pedidos_de_assinatura_em_aberto`). Se o cliente faz um pedido
 * NOVO nesse meio-tempo, a fatura antiga sai do Asaas ANTES de a nova ser criada: sem isso ele poderia pagar as duas.
 *
 * Quem chama é `iniciarCompra` (`compra.ts`), no ponto em que o pedido novo de assinatura vai ganhar a cobrança.
 * A remoção é a mesma do passo 3 da conciliação (`conciliar.ts`): assinatura do pedido inteira, parcelamento
 * inteiro, ou a cobrança avulsa; 404 já conta como removida (o cliente do Asaas trata).
 *
 * Antes de remover, um GET na cobrança: se ela já foi paga e o evento ainda não chegou, nada é removido e a compra
 * nova não segue (o pagamento antigo vai liberar o acesso). Nunca lança.
 */
import type { ClienteAsaasHttp } from "./cliente";
import { ErroAsaasException } from "./erros";

/** Um pedido de assinatura `vencido` da organização, com o que o Asaas tem dele. */
export interface PedidoVencidoComFatura {
  id: string;
  asaasPaymentId: string | null;
  asaasSubscriptionId: string | null;
  asaasInstallmentId: string | null;
}

export type DesfechoDaRemocaoAnterior = "ok" | "pago" | "falhou";

const STATUS_PAGO = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);

interface LoggerDaRemocao {
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

function tipoDoErro(err: unknown): string {
  return err instanceof ErroAsaasException ? err.erro.tipo : "desconhecido";
}

/**
 * Remove no Asaas a fatura de cada pedido vencido. `ok` = todas removidas (ou já não existiam); `pago` = alguma já
 * foi paga (a compra nova deve esperar); `falhou` = alguma não saiu (a compra nova não deve seguir agora).
 */
export async function removerFaturasDePedidosVencidos(
  asaas: ClienteAsaasHttp,
  pedidos: readonly PedidoVencidoComFatura[],
  logger: LoggerDaRemocao,
): Promise<DesfechoDaRemocaoAnterior> {
  for (const pedido of pedidos) {
    if (!pedido.asaasPaymentId && !pedido.asaasSubscriptionId && !pedido.asaasInstallmentId) continue;
    try {
      if (pedido.asaasPaymentId) {
        const cobranca = await asaas.buscarCobranca(pedido.asaasPaymentId);
        if (!("removido" in cobranca) && STATUS_PAGO.has(cobranca.status)) return "pago";
      }
      if (pedido.asaasSubscriptionId) {
        await asaas.removerAssinatura(pedido.asaasSubscriptionId);
      } else if (pedido.asaasInstallmentId) {
        await asaas.removerParcelamento(pedido.asaasInstallmentId);
      } else if (pedido.asaasPaymentId) {
        await asaas.removerCobranca(pedido.asaasPaymentId);
      }
    } catch (err) {
      logger.warn("asaas_compra_remover_fatura_vencida_falhou", { pedidoId: pedido.id, tipoErro: tipoDoErro(err) });
      return "falhou";
    }
  }
  return "ok";
}
