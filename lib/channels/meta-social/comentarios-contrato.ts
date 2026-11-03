/**
 * O CONTRATO dos comentários do Instagram (migration 0991): o vocabulário, o
 * evento e os limites que a automação consome. Puro, sem banco nem rede.
 * Explicação para quem consome: docs/specs/instagram-comentarios-contrato.md.
 *
 * As listas `as const` abaixo espelham os CHECK do banco e são cobradas por
 * tests/invariants/vocabulario-banco-x-typescript.test.ts.
 */

/** `meta_social_comentarios.resposta_privada_status`. */
export const STATUS_DA_RESPOSTA_PRIVADA = ["nao_pedida", "na_fila", "enviada", "falhou", "expirada"] as const;
export type StatusDaRespostaPrivada = (typeof STATUS_DA_RESPOSTA_PRIVADA)[number];

/** `meta_social_fila_de_envio.tipo`. */
export const TIPOS_DA_FILA_DE_ENVIO = ["resposta_privada", "resposta_publica"] as const;
export type TipoDaFilaDeEnvio = (typeof TIPOS_DA_FILA_DE_ENVIO)[number];

/** `meta_social_fila_de_envio.status`. `enviando` = reservado pelo cron, envio em curso. */
export const STATUS_DA_FILA_DE_ENVIO = ["na_fila", "enviando", "enviada", "falhou", "expirada"] as const;
export type StatusDaFilaDeEnvio = (typeof STATUS_DA_FILA_DE_ENVIO)[number];

/** O tipo do evento emitido no `event_log` a cada comentário novo. */
export const EVENTO_COMENTARIO_RECEBIDO = "instagram.comentario_recebido";
/** `event_log.entity_kind` desse evento; `entity_id` = `meta_social_comentarios.id`. */
export const ENTIDADE_DO_EVENTO_COMENTARIO = "instagram_comment";

/**
 * O payload do evento (snake_case, datas em ISO-8601). Montado pela função do
 * banco `fn_meta_social_registrar_comentario` (0991), na mesma transação da
 * linha. A linha em si é o `event_log.entity_id` (`meta_social_comentarios.id`).
 */
export interface EventoComentarioRecebido {
  organization_id: string;
  channel_session_id: string;
  /** Id do comentário na Meta: é o que as ações recebem. */
  comment_id: string;
  media_id: string | null;
  media_product_type: string | null;
  /** IGSID de quem comentou. */
  autor_id: string;
  autor_usuario: string | null;
  texto: string | null;
  /** Hora do aviso da Meta (`entry.time`); a hora exata do comentário não vem no webhook. */
  criado_na_meta_em: string | null;
}

/** As chaves do payload, para o invariante comparar com o que o banco emite. */
export const CAMPOS_DO_EVENTO_COMENTARIO = [
  "organization_id",
  "channel_session_id",
  "comment_id",
  "media_id",
  "media_product_type",
  "autor_id",
  "autor_usuario",
  "texto",
  "criado_na_meta_em",
] as const satisfies readonly (keyof EventoComentarioRecebido)[];

/**
 * A Meta aceita resposta privada a comentário de post ou reel em até 7 dias da
 * criação do comentário.
 * https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies
 */
export const PRAZO_DA_RESPOSTA_PRIVADA_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Teto NOSSO de respostas privadas por conta do Instagram, por hora corrida
 * (o que saiu nos últimos 60 minutos). A Meta permite 750 chamadas por hora
 * por conta profissional; 600 deixa 20% de folga para outros envios e
 * relógios diferentes.
 * https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting
 */
export const TETO_DE_RESPOSTAS_PRIVADAS_POR_HORA = 600;

/** Teto do texto de uma resposta, em bytes UTF-8 (o mesmo do Direct do Instagram). */
export const TETO_DO_TEXTO_DA_RESPOSTA_BYTES = 1000;
