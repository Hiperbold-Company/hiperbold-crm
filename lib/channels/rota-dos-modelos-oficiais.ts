/**
 * A rota dos modelos de UMA conta oficial (WABA).
 *
 * Desde 17/11/2026 a organização pode ter várias conexões oficiais. Com `channelSessionId` (tela
 * em cartões) a rota responde por aquela conexão, na leitura e na escrita (`?channel_session_id=` na
 * query, nos dois métodos); sem ele, pela conexão oficial mais antiga, como antes.
 */
export function rotaDosModelosOficiais(channelSessionId?: string): string {
  return channelSessionId
    ? `/api/v1/channels/templates?channel_session_id=${encodeURIComponent(channelSessionId)}`
    : "/api/v1/channels/templates";
}
