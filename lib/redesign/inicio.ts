import { useRedesign } from "@/lib/redesign/contexto";

/**
 * As peças das telas Início e Tarefas (com Planos de tarefa) que o redesign
 * desenha (bloco `/* redesign: inicio *\/` de `app/globals.css`). As peças de
 * Tarefas levam o prefixo `tarefas-`; as de Planos, `planos-`.
 *
 * Este arquivo NÃO é "use client": a página de servidor chama `marcaDoInicio`
 * (função pura) com `redesignLigado()` de `lib/redesign/chave.ts` — que é
 * server-only e nunca pode ser importado aqui. Componente cliente usa o hook.
 */
export type PecaDoInicio =
  | "tela"
  | "cabecalho"
  | "progresso"
  | "secao-titulo"
  | "passo"
  | "passo-cartao"
  | "periodo"
  | "secao"
  | "barra"
  | "tarefas-tela"
  | "tarefas-cabecalho"
  | "tarefas-filtros"
  | "tarefas-visoes"
  | "tarefas-lista"
  | "tarefas-faixa"
  | "tarefas-grupo"
  | "tarefas-linha"
  | "tarefas-prioridade"
  | "tarefas-vazio"
  | "tarefas-falha"
  | "tarefas-formulario"
  | "tarefas-calendario"
  | "tarefas-calendario-dia"
  | "planos-tela"
  | "planos-cabecalho"
  | "planos-cartao"
  | "planos-editor"
  | "planos-passo";

/**
 * A marca de uma peça: o valor de `data-rd-inicio`, só com a chave LIGADA.
 * Desligada devolve `undefined` e o React não escreve o atributo — o DOM fica
 * exatamente o de antes do redesign.
 */
export function marcaDoInicio(ligado: boolean): (peca: PecaDoInicio) => PecaDoInicio | undefined {
  return (peca) => (ligado ? peca : undefined);
}

/** A mesma marca, para componente cliente (lê a chave do contexto). */
export function useMarcaDoInicio(): (peca: PecaDoInicio) => PecaDoInicio | undefined {
  return marcaDoInicio(useRedesign());
}
