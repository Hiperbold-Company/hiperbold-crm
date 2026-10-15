/**
 * O que o passo "Plano" do wizard faz com o `status` de um pedido de assinatura (`billing_orders`).
 * Pura, sem servidor nem React: a tela e o teste leem a mesma regra.
 *
 *  - `aguardando`: a cobrança existe e ainda não foi paga (Pix gerado, cartão no Asaas, ou o pedido
 *    ainda sendo montado). O wizard NÃO avança e deixa abrir a cobrança de novo.
 *  - `confirmado`: o Asaas confirmou. O wizard segue assim que o servidor vir o contrato ativo.
 *  - `encerrado`: vencido, cancelado, falhou ou estornado. Nada a esperar: volta o formulário.
 */
export type SituacaoDoPedido = "aguardando" | "confirmado" | "encerrado";

const AGUARDANDO = new Set(["criado", "processando", "aguardando_pagamento", "inconclusivo"]);

export function situacaoDoPedido(status: string | null | undefined): SituacaoDoPedido {
  if (status === "pago") return "confirmado";
  if (status && AGUARDANDO.has(status)) return "aguardando";
  return "encerrado";
}

/** A reserva do cupom dura 24 h (ver `lib/billing/asaas/compra.ts`): depois disso o pedido aberto é considerado parado. */
export const PEDIDO_PARADO_APOS_MS = 24 * 60 * 60 * 1000;

/**
 * O passo "Plano" deve voltar a mostrar o FORMULÁRIO apesar de haver um pedido aberto? É a saída de quem
 * ficou preso numa tela de "aguardando" que não vai andar:
 *
 *  - `inconclusivo` SEM fatura: o POST ao Asaas deu timeout, não há Pix nem cartão para abrir. A nova tentativa
 *    retoma o MESMO pedido (a recuperação por `externalReference` da compra), não cria outro;
 *  - qualquer pedido ainda aberto (não `pago`) criado há mais de 24 h.
 *
 * Não há aqui risco de cobrança em dobro: o banco só admite UM pedido aberto por organização e tipo
 * (`billing_pedido_aberto_existe`, migration 0909), e a compra, ao ser repetida com a mesma oferta, retoma o
 * pedido existente e devolve a MESMA cobrança; com outra oferta recusa. Pedido `pago` nunca sai daqui.
 */
export function podeEscolherOutraForma(
  pedido: { status: string; invoiceUrl: string | null; criadoEm: string | null },
  agora: number = Date.now(),
): boolean {
  if (situacaoDoPedido(pedido.status) !== "aguardando") return false;
  if (pedido.status === "inconclusivo" && !pedido.invoiceUrl) return true;
  const criado = pedido.criadoEm ? Date.parse(pedido.criadoEm) : NaN;
  return Number.isFinite(criado) && agora - criado > PEDIDO_PARADO_APOS_MS;
}
