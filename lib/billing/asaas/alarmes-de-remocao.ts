/**
 * Os alarmes de `fn_billing_asaas_aplicar_evento` que mandam o CRM REMOVER a cobrança no Asaas:
 * `remover_assinatura_pendente` (a assinatura, e `tentarRemoverAssinatura` leva a cobrança junto) e
 * `remover_cobranca_pendente` (a cobrança ou o parcelamento avulso, `tentarRemoverCobranca`). Saem do estorno
 * total que corta o acesso e do `PAYMENT_OVERDUE` de pedido de PACOTE DE TOKENS.
 *
 * Desde a migration 1026 o `PAYMENT_OVERDUE` de pedido de ASSINATURA não traz alarme nenhum: a fatura fica no Asaas
 * para a régua de cobrança (`lib/email/conta-e-cobranca/regua-de-cobranca.ts`), e quem a remove é o passo 3 da
 * conciliação (`conciliar.ts`), no prazo de `fn_billing_pedidos_de_assinatura_em_aberto`.
 */
export const ALARME_REMOVER_ASSINATURA = "remover_assinatura_pendente";
export const ALARME_REMOVER_COBRANCA = "remover_cobranca_pendente";
