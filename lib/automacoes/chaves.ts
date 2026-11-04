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

/**
 * Os `event_type` que o desfecho de uma resposta do Instagram ganha no
 * histórico da execução (`desfecho-da-resposta.handler.ts`). Moram aqui para
 * a uma voz (`uma-voz.ts`) os reconhecer sem importar o handler.
 */
export const EVENTO_DA_EXECUCAO_RESPOSTA_SAIU = "instagram_resposta_saiu";
export const EVENTO_DA_EXECUCAO_RESPOSTA_FALHOU = "instagram_resposta_falhou";
