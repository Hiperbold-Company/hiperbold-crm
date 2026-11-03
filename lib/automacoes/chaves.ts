/**
 * Chaves estáveis das automações que outros processos leem sem importar o
 * handler inteiro (o drain do agente roda no worker e só precisa do nome).
 */

/** O consumidor do `event_log` que inicia automações (`event_log.consumed_by`). */
export const AUTOMACAO_GATILHOS_HANDLER_KEY = "automacao-gatilhos.v1";

/**
 * `event_log.metadata.via` de evento emitido por AÇÃO EM MASSA (tag em lote na
 * lista de negócios). Como a planilha importada, ação em massa não inicia
 * automação: marcar 300 negócios não pode abrir 300 conversas de uma vez.
 */
export const VIA_ACAO_EM_MASSA = "bulk";
