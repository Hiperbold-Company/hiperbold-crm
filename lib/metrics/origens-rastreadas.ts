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
  /** Negócios criados com origem rastreada (soma das chaves não nulas). */
  comOrigem: number;
  /** Negócios criados sem origem (a linha de chave nula). */
  semOrigem: number;
  /** Ganhos dos negócios de origem rastreada. */
  ganhosRastreados: number;
  /** ganhosRastreados ÷ comOrigem, de 0 a 1; `null` quando não há criados com origem (divisor zero). */
  taxaDeGanhoRastreada: number | null;
}

export function resumoDeOrigens(porSource: readonly LinhaDeOrigemMinima[]): ResumoDeOrigens {
  let comOrigem = 0;
  let semOrigem = 0;
  let ganhosRastreados = 0;
  for (const linha of porSource) {
    if (linha.chave === null) {
      semOrigem += linha.total;
    } else {
      comOrigem += linha.total;
      ganhosRastreados += linha.ganhos;
    }
  }
  return {
    comOrigem,
    semOrigem,
    ganhosRastreados,
    taxaDeGanhoRastreada: comOrigem > 0 ? ganhosRastreados / comOrigem : null,
  };
}

/** "12,5%"-style: uma casa decimal como a aba Origens (`Math.round(x * 1000) / 10`), ou "—" sem divisor. */
export function formatarTaxa(taxa: number | null): string {
  return taxa === null ? "—" : `${Math.round(taxa * 1000) / 10}%`;
}
