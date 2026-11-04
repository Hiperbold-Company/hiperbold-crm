/**
 * Quais sessões de canal servem de conversa do DIRECT (mensagem privada de rede
 * social) — a pergunta que o bloco de mensagem das automações faz quando a
 * execução começou por um comentário. Mora em `lib/channels/` pelo mesmo motivo
 * de `canal-de-whatsapp.ts`: a resposta depende de provider, e fora daqui
 * ninguém o nomeia (invariante 1 de `docs/doctrine/restricao-de-canal.md`).
 */
import { ehCanalSocial, transportaMensagem } from "./capabilities";

export function ehCanalDoDirect(provider: string | null | undefined): boolean {
  return transportaMensagem(provider) && ehCanalSocial(provider);
}
