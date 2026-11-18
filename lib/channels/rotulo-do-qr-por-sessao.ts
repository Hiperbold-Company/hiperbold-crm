/**
 * Rótulo da conexão de WhatsApp por QR Code pelo WAHA, na tela de Conexões (Criar e cartão).
 *
 * Hiperbold (18/11/2026): o WAHA volta como TERCEIRA forma de conexão, ao lado da UAZAPI e da
 * API oficial, quando a instalação o tem configurado. O nome mora aqui, em `lib/channels/`,
 * porque a cerca `lint:channels` proíbe nomear provider nas telas (mesmo motivo de
 * `rotulo-da-aba-instancia.ts`). Arquivo sem dependências: a tela é um componente de cliente.
 */
export const ROTULO_DO_QR_POR_SESSAO = "WhatsApp por QR Code (WAHA)";
