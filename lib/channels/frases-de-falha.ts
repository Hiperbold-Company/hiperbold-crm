/**
 * O QUE DIZER À PESSOA quando o canal recusou a mensagem.
 *
 * Mora em `lib/channels/` pelo mesmo motivo que `adapter.codes` mora: as
 * chaves CARREGAM NOME DE PROVIDER (`waha_error`, `meta_not_configured`), e a
 * doutrina de restrição de canal (`docs/doctrine/restricao-de-canal.md`,
 * invariante 1) proíbe esse nome fora daqui — `scripts/lint-channels.ts`
 * reprova, e reprovou este arquivo quando o mapa nasceu dentro de
 * `lib/automation/`.
 *
 * A regra não é burocracia: quem chama não pode ramificar por provider, senão o
 * quarto canal exige editar N lugares espalhados. Aqui a tradução é uma função
 * pura que aceita o código VINDO do adapter e devolve texto de tela — quem
 * chama nunca precisa saber de quem é o código.
 *
 * Texto de TELA, não de log: quem lê é o dono do negócio na aba Atividade, e a
 * frase tem que dizer o que ele faz a respeito. "waha_error" não diz.
 */

const FRASES: Record<string, string> = {
  // Sessão do canal fora de WORKING — o número está desconectado.
  channel_session_not_working:
    "O número escolhido não está conectado no momento. Reconecte em Conexões — a mensagem sai sozinha quando ele voltar.",
  // Credencial do transporte ausente no ambiente da instalação.
  waha_not_configured: "A conexão de WhatsApp ainda não foi configurada nesta instalação.",
  meta_not_configured: "A conexão de WhatsApp ainda não foi configurada nesta instalação.",
  zernio_not_configured: "A conexão de WhatsApp ainda não foi configurada nesta instalação.",
  // Canal excluído da Central de Conexões (migration 0106).
  channel_archived:
    "Esse número foi excluído da Central de Conexões. Escolha outro número nesta automação.",
  missing_phone_number: "O contato não tem telefone para receber a mensagem.",
  // O transporte não respondeu, ou respondeu erro.
  waha_error: "Não conseguimos falar com o serviço de WhatsApp. Confira se ele está no ar.",
  meta_error: "O WhatsApp Oficial recusou o envio. Confira a conexão em Conexões.",
  zernio_error: "O canal recusou o envio. Confira a conexão em Conexões.",
  // Instagram Direct e Messenger pela conexão oficial (`meta_social`). A
  // mensagem da Meta nunca chega ao operador crua: o adapter traduz o erro
  // num destes códigos (`codigoDaFalhaDeEnvio`).
  meta_social_not_configured: "A conexão com o Instagram e o Messenger ainda não foi configurada nesta instalação.",
  meta_social_send_failed: "A rede recusou o envio. Confira a conexão em Conexões › Redes sociais.",
  meta_social_error: "Não conseguimos falar com a Meta agora. Tente de novo em alguns minutos.",
  meta_social_token_invalid: "O acesso a esta conta venceu ou foi retirado. Reconecte em Conexões › Redes sociais.",
  meta_social_outside_window:
    "Passaram mais de 24 horas desde a última mensagem do cliente. A Meta só libera a resposta quando ele escrever de novo.",
  meta_social_recipient_unavailable: "Esta pessoa não pode receber mensagens desta conta agora.",
  meta_social_messages_access_off:
    "O dono da conta desligou \"Permitir acesso às mensagens\" no Instagram. Peça para ligar em Configurações > Mensagens e respostas de stories > Ferramentas conectadas.",
  meta_social_account_not_eligible:
    "Esta conta do Instagram precisa ser profissional (Empresa ou Criador) e ter a permissão de mensagens. Ajuste e conecte de novo em Conexões › Redes sociais.",
  // Falha do NOSSO Storage ao preparar a mídia — não é do canal.
  storage_sign_failed: "Não conseguimos preparar o arquivo para envio.",
};

/**
 * `null` quando o código não tem tradução — e o `null` é deliberado: quem
 * chama decide o texto de reserva, e uma frase genérica inventada aqui
 * ("houve um erro") apagaria a mensagem original do provedor, que às vezes é a
 * única pista real.
 */
export function fraseDaFalhaDeCanal(codigo: string | null | undefined): string | null {
  if (!codigo) return null;
  return FRASES[codigo] ?? null;
}
