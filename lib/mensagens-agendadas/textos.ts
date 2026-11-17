/**
 * Frases da mensagem agendada que a tela e o servidor dizem iguais (migration 1017).
 *
 * Literais, e não montadas: são chaves do dicionário (`lib/i18n/dicionario.ts`),
 * e uma chave montada com `${...}` não casa com entrada nenhuma. Sem import do
 * servidor aqui: a tela importa este arquivo.
 */

/** O número casa com `PRAZO_MAXIMO_DIAS` (`regras.ts`); o teste das regras confere. */
export const MENSAGEM_HORARIO_INVALIDO = "Escolha um horário no futuro, em até 90 dias.";
