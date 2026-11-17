/**
 * Os alarmes de `fn_billing_asaas_aplicar_evento` que mandam o CRM REMOVER a cobrança no Asaas depois de um
 * `PAYMENT_OVERDUE` de pedido que venceu sem pagar: `remover_assinatura_pendente` (a assinatura do pedido, e
 * `tentarRemoverAssinatura` leva a cobrança junto) e `remover_cobranca_pendente` (a cobrança ou o parcelamento
 * avulso, `tentarRemoverCobranca`).
 *
 * É a MESMA regra para quem remove (`processar-eventos.ts`) e para quem avisa o cliente
 * (`lib/email/conta-e-cobranca/gatilhos-de-cobranca.ts`): o e-mail não pode levar a uma fatura que o próprio CRM
 * apaga logo em seguida. Sem dependências, de propósito: o gatilho de e-mail a importa sem puxar o processador.
 */
export const ALARME_REMOVER_ASSINATURA = "remover_assinatura_pendente";
export const ALARME_REMOVER_COBRANCA = "remover_cobranca_pendente";

export function alarmesPedemRemoverACobranca(alarmes: readonly string[]): boolean {
  return alarmes.includes(ALARME_REMOVER_ASSINATURA) || alarmes.includes(ALARME_REMOVER_COBRANCA);
}
