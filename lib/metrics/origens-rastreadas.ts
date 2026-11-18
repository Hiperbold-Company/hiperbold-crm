/**
 * Os quatro números de origem do painel do Início, calculados do que `GET /api/v1/metrics/origens`
 * já devolve em `por_source`. Função PURA: sem I/O, de modo que as contas se provam em teste.
 *
 * "Rastreada" = a linha tem `chave` (a `utm_source` gravada no negócio). A linha de chave nula é o
 * negócio sem origem. Atenção: o `ganhos` do cartão "Ganhos" da aba Origens soma TODAS as linhas,
 * inclusive a sem origem; aqui os ganhos são só os de origem rastreada, e a taxa divide por
 * criados com origem rastreada, para numerador e denominador serem do mesmo conjunto.
 */
export interface LinhaDeOrigemMinima {
  chave: string | null;
  total: number;
  ganhos: number;
}

export interface ResumoDeOrigens {
  /** Negócios criados com origem rastreada: `total − semOrigem`. `null` quando semOrigem é desconhecido. */
  comOrigem: number | null;
  /** Negócios criados sem origem (a linha de chave nula). `null` se a linha não veio por corte. */
  semOrigem: number | null;
  /** Ganhos dos negócios de origem rastreada; parcial quando `parcial`. */
  ganhosRastreados: number;
  /** ganhosRastreados ÷ comOrigem, de 0 a 1; `null` sem divisor. Parcial quando `parcial`. */
  taxaDeGanhoRastreada: number | null;
  /** A leitura cortou as origens (o endpoint devolve no máximo 50): ganhos e taxa são parciais. */
  parcial: boolean;
}

/**
 * @param porSource linhas de `por_source` (no máximo 50, as de mais negócios)
 * @param total negócios criados no período, de todas as origens (`total` do endpoint)
 * @param cortado `cortado.source` do endpoint
 */
export function resumoDeOrigens(
  porSource: readonly LinhaDeOrigemMinima[],
  total: number,
  cortado: boolean,
): ResumoDeOrigens {
  let semOrigem: number | null = null;
  let ganhosRastreados = 0;
  for (const linha of porSource) {
    if (linha.chave === null) {
      semOrigem = (semOrigem ?? 0) + linha.total;
    } else {
      ganhosRastreados += linha.ganhos;
    }
  }
  // Sem a linha nula: se não houve corte, não há negócio sem origem; se houve, não dá para saber.
  if (semOrigem === null && !cortado) semOrigem = 0;
  const comOrigem = semOrigem === null ? null : total - semOrigem;
  return {
    comOrigem,
    semOrigem,
    ganhosRastreados,
    taxaDeGanhoRastreada: comOrigem !== null && comOrigem > 0 ? ganhosRastreados / comOrigem : null,
    parcial: cortado,
  };
}

/** "12,5%"-style: uma casa decimal como a aba Origens (`Math.round(x * 1000) / 10`), ou "—" sem divisor. */
export function formatarTaxa(taxa: number | null): string {
  return taxa === null ? "—" : `${Math.round(taxa * 1000) / 10}%`;
}
