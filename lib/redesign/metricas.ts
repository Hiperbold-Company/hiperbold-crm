import { useRedesign } from "@/lib/redesign/contexto";

/**
 * As peças das telas Desempenho e Agentes de IA que o redesign desenha (bloco
 * `/* redesign: metricas *\/` de `app/globals.css`). As do Agentes levam o
 * prefixo `agentes-`.
 *
 * SEM a marca de cliente no topo, de propósito: a página de SERVIDOR usa
 * `marcaDasMetricas(await redesignNaRequisicao())`, e o componente cliente usa o hook.
 * Este arquivo nunca importa `lib/redesign/chave.ts` (server-only).
 */
export type PecaDasMetricas =
  | "tela"
  | "cabecalho"
  | "filtros"
  | "abas"
  | "kpi"
  | "painel"
  | "meta"
  | "agentes-tela"
  | "agentes-cabecalho"
  | "agentes-filtros"
  | "agentes-grade"
  | "agentes-cartao"
  | "agentes-vazio"
  | "agentes-tipo"
  | "agente-tela"
  | "agente-operacao";

export type MarcaDasMetricas = (peca: PecaDasMetricas) => PecaDasMetricas | undefined;

/** A regra pura: com a chave ligada devolve a peça; desligada, `undefined` (o React não escreve o atributo). */
export function marcaDasMetricas(ligado: boolean): MarcaDasMetricas {
  return (peca) => (ligado ? peca : undefined);
}

/** No cliente: lê a chave do contexto do redesign. */
export function useMarcaDasMetricas(): MarcaDasMetricas {
  return marcaDasMetricas(useRedesign());
}
