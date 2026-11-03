/**
 * Quais canais de mensagem são WhatsApp — a pergunta que o bloco de mensagem
 * das automações faz antes de escolher a conversa do contato. Mora em
 * `lib/channels/` porque nomeia provider (invariante 1 de
 * `docs/doctrine/restricao-de-canal.md`): Instagram e Messenger transportam
 * mensagem, mas não são a conversa de WhatsApp que a automação usa.
 */
import { transportaMensagem } from "./capabilities";

const PROVIDERS_DE_WHATSAPP: readonly string[] = [
  "waha",
  "meta_cloud",
  "zernio",
  "datafy",
  "uazapi",
];

export function ehCanalDeWhatsapp(provider: string | null | undefined): boolean {
  return transportaMensagem(provider) && PROVIDERS_DE_WHATSAPP.includes(provider ?? "");
}
