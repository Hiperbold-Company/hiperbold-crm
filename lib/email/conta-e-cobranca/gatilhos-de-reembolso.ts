/**
 * Os avisos do pedido de reembolso do cliente (migration 0957): COB-10 ao cliente ("Recebemos sua solicitação") e
 * COB-11 ao financeiro da instalação (`EMAIL_DO_FINANCEIRO`, ou, vazio, os mesmos da cópia dos avisos). Quem chama
 * é a ação `solicitarReembolso`, DEPOIS de o pedido estar gravado: o gatilho só ENFILEIRA (`fila.ts`) e nunca
 * lança nem desfaz o pedido. A chave dos dois é o próprio pedido (`reembolso:<id>`), então repetir não duplica.
 *
 * Também mora aqui a outra metade do ciclo: quando o processamento do webhook confirma o estorno total
 * (`PAYMENT_REFUNDED`), `concluirPedidoDeReembolsoDoPagamento` fecha como `concluido` o pedido aberto daquele
 * pagamento (o cliente já recebe o COB-08, "estorno feito", pelo gatilho de cobrança).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { MotivoDeCancelamento } from "@/lib/billing/reembolso/motivos";
import { linkDaCobrancaNoAsaas } from "@/lib/billing/reembolso/link-asaas";
import { logger } from "@/lib/logger";

import { enfileirarEmailDeConta, type Enfileirador } from "./fila";

export interface PedidoDeReembolsoGravado {
  organizationId: string;
  /** `billing_refund_requests.id`. */
  id: string;
  asaasPaymentId: string;
  amountCents: number;
  paidAt: string;
  dentro7Dias: boolean;
  motivo: MotivoDeCancelamento;
  /** O texto livre do cancelamento. */
  motivoDetalhe: string | null;
  /** A observação do pedido. */
  observacao: string | null;
  plano: string | null;
  invoiceUrl: string | null;
  ambiente: "sandbox" | "producao" | null;
}

export interface DepsDosGatilhosDeReembolso {
  enfileirar?: Enfileirador;
}

function motivoDoErro(erro: unknown): string {
  return erro instanceof Error ? erro.message.replace(/\S+@\S+/g, "***").slice(0, 120) : "erro";
}

/** Junta o texto do cancelamento e a observação do pedido numa linha só para o financeiro (até 1000 caracteres). */
function detalheParaOFinanceiro(pedido: Pick<PedidoDeReembolsoGravado, "motivoDetalhe" | "observacao">): string | null {
  const partes = [
    pedido.motivoDetalhe ? `No cancelamento: ${pedido.motivoDetalhe}` : null,
    pedido.observacao ? `No pedido: ${pedido.observacao}` : null,
  ].filter((p): p is string => !!p);
  if (partes.length === 0) return null;
  return partes.join(" | ").slice(0, 1000);
}

export function criarAvisoDePedidoDeReembolsoSobre(
  admin: SupabaseClient,
  deps: DepsDosGatilhosDeReembolso = {},
): (pedido: PedidoDeReembolsoGravado) => Promise<void> {
  const enfileirar = deps.enfileirar ?? ((entrada) => enfileirarEmailDeConta(entrada, admin));
  return async (pedido) => {
    const chave = `reembolso:${pedido.id}`;
    try {
      await enfileirar({
        organizationId: pedido.organizationId,
        emailId: "COB-10",
        chave,
        destino: "admins",
        copiaParaOperador: false,
        dados: { valor: pedido.amountCents, plano: pedido.plano, pagoEm: pedido.paidAt },
      });
    } catch (erro) {
      logger.warn("[email-de-conta] o aviso ao cliente do pedido de reembolso falhou", {
        organization_id: pedido.organizationId,
        motivo: motivoDoErro(erro),
      });
    }
    try {
      await enfileirar({
        organizationId: pedido.organizationId,
        emailId: "COB-11",
        chave,
        destino: "financeiro",
        copiaParaOperador: false,
        dados: {
          valor: pedido.amountCents,
          plano: pedido.plano,
          pagoEm: pedido.paidAt,
          dentro7Dias: pedido.dentro7Dias,
          motivo: pedido.motivo,
          detalhe: detalheParaOFinanceiro(pedido),
          faturaUrl: linkDaCobrancaNoAsaas({
            asaasPaymentId: pedido.asaasPaymentId,
            invoiceUrl: pedido.invoiceUrl,
            ambiente: pedido.ambiente,
          }),
        },
      });
    } catch (erro) {
      logger.warn("[email-de-conta] o aviso ao financeiro do pedido de reembolso falhou", {
        organization_id: pedido.organizationId,
        motivo: motivoDoErro(erro),
      });
    }
  };
}

/**
 * Fecha como `concluido` o pedido de reembolso aberto do pagamento (organização + id do Asaas). Devolve quantos
 * fechou; nunca lança (o estorno já está gravado, e o pedido que sobrar aberto o admin fecha à mão).
 */
export async function concluirPedidoDeReembolsoDoPagamento(
  admin: SupabaseClient,
  organizationId: string,
  asaasPaymentId: string,
): Promise<number> {
  try {
    const { data, error } = await admin.rpc("fn_billing_reembolso_concluir_por_pagamento" as never, {
      p_org: organizationId,
      p_asaas_payment_id: asaasPaymentId,
    } as never);
    if (error) throw new Error((error as { message: string }).message);
    const fechados = typeof data === "number" ? data : Number(data ?? 0);
    if (fechados > 0) {
      logger.info("[reembolso] pedido concluído pelo estorno do Asaas", { organization_id: organizationId, fechados });
    }
    return Number.isFinite(fechados) ? fechados : 0;
  } catch (erro) {
    logger.warn("[reembolso] não deu para concluir o pedido pelo estorno", {
      organization_id: organizationId,
      motivo: motivoDoErro(erro),
    });
    return 0;
  }
}
