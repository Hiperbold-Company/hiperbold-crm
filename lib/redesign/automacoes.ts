import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DAS AUTOMAÇÕES QUE O REDESIGN PINTA.
 *
 * Vale para Automações (lista e editor), Follow-ups, Roteadores e Execuções.
 * As telas não foram copiadas: os componentes são os mesmos, com os mesmos
 * hooks, ações, permissões e `data-testid`. Com a chave ligada, cada peça ganha
 * `data-rd-automacoes="<peça>"`, e o bloco `/* redesign: automacoes *\/` de
 * `app/globals.css` (todo ele sob `[data-redesign="ligado"]`) a desenha como o
 * protótipo v49.
 *
 * Desligada, `rd()` devolve `undefined` e o React não escreve atributo nenhum:
 * o DOM sai idêntico ao de antes.
 */
export type PecaDasAutomacoes =
  | "pagina"
  | "cabecalho"
  | "titulo"
  | "descricao"
  | "link-secundario"
  | "barra"
  | "busca"
  | "filtros"
  | "grade"
  | "cartao"
  | "cartao-corpo"
  | "cartao-nome"
  | "cartao-tipo"
  | "cartao-rodape"
  | "estado"
  | "vazio"
  | "faixa-erro"
  | "lista"
  | "item"
  | "resumo"
  | "abas"
  | "editor"
  | "barra-do-editor"
  | "paleta"
  | "tela"
  | "painel";

export type MarcaDasAutomacoes = (peca: PecaDasAutomacoes) => PecaDasAutomacoes | undefined;

/** A regra pura, também usada pelas páginas de servidor (que leem a chave no servidor). */
export function marcaDasAutomacoes(ligado: boolean): MarcaDasAutomacoes {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDasAutomacoes(): MarcaDasAutomacoes {
  return marcaDasAutomacoes(useRedesign());
}
