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

/**
 * As abas que um link do upstream pode abrir direto (`/app/webhooks?aba=automacoes`,
 * a volta do designer), traduzidas para o valor interno da aba. O `?tab=` da
 * Hiperbold continua valendo; quem lê os dois é a página. Mora aqui, e não no
 * `WebhooksClient` ("use client"): a página de servidor lê o VALOR, e valor de
 * módulo cliente chega ao servidor como referência, não como objeto.
 */
export const ABAS_DOS_WEBHOOKS = {
  receber: "sources",
  leads: "capturas",
  automacoes: "rules",
  atividade: "activity",
} as const satisfies Record<string, AbaDeAutomacoes>;
export type AbaDosWebhooks = keyof typeof ABAS_DOS_WEBHOOKS;
