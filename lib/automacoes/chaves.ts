/**
 * Chaves estáveis das automações que outros processos leem sem importar o
 * handler inteiro (o drain do agente roda no worker e só precisa do nome).
 */

/** O consumidor do `event_log` que inicia automações (`event_log.consumed_by`). */
export const AUTOMACAO_GATILHOS_HANDLER_KEY = "automacao-gatilhos.v1";
