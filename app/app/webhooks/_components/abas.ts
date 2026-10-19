/**
 * As abas de Automações e Webhooks (rota `/app/webhooks`, que não muda).
 *
 * Os valores são os de sempre (`sources`, `capturas`, `rules`, `activity`): só
 * rótulo e ordem mudaram, e `?tab=` aceita esses mesmos valores para abrir uma
 * aba direto. Valor ausente ou desconhecido cai em Automações, a aba de
 * destaque — a tela se chamava "Webhooks" e ninguém achava as regras ali.
 */
export const ABAS_DE_AUTOMACOES = ["rules", "sources", "capturas", "activity"] as const;
export type AbaDeAutomacoes = (typeof ABAS_DE_AUTOMACOES)[number];
export const ABA_PADRAO_DE_AUTOMACOES: AbaDeAutomacoes = "rules";

export function abaInicialDeAutomacoes(valor: string | null | undefined): AbaDeAutomacoes {
  return (ABAS_DE_AUTOMACOES as readonly string[]).includes(valor ?? "")
    ? (valor as AbaDeAutomacoes)
    : ABA_PADRAO_DE_AUTOMACOES;
}
