"use client";
import { useRedesign } from "@/lib/redesign/contexto";

/**
 * As peças da tela Pipeline que o redesign desenha (bloco `/* redesign: pipeline *\/`
 * de `app/globals.css`).
 */
export type PecaDoPipeline =
  | "tela"
  | "cabecalho"
  | "visoes"
  | "identidade"
  | "filtros"
  | "quadro"
  | "coluna"
  | "coluna-topo"
  | "coluna-corpo"
  | "coluna-vazia"
  | "cartao"
  | "cartao-identidade"
  | "cartao-titulo"
  | "cartao-valor"
  | "cartao-sem-valor"
  | "cartao-rodape"
  | "ficha"
  | "ficha-resumo"
  | "secao"
  | "conversa"
  | "funis";

/**
 * Marca de uma peça da tela Pipeline: o valor de `data-rd-pipeline`, só com a
 * chave do redesign LIGADA. Desligada devolve `undefined`, e o React não
 * escreve o atributo — o DOM fica exatamente o de antes do redesign.
 */
export function useMarcaDoPipeline(): (peca: PecaDoPipeline) => PecaDoPipeline | undefined {
  const ligado = useRedesign();
  return (peca) => (ligado ? peca : undefined);
}
