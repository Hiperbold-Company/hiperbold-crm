import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DAS TELAS DE IA QUE O REDESIGN PINTA (onda 4).
 *
 * Vale para Agentes (lista e cabeçalho do editor), Conhecimento, Casos e
 * Evolução da IA, e para o que as telas de Roteadores e Execuções acrescentam
 * às marcas que já tinham. Os componentes são os de sempre, com os mesmos
 * hooks, ações, permissões e `data-testid`; com a chave ligada cada peça ganha
 * `data-rd-ia="<peça>"`, e o bloco `/* redesign: ia *\/` de `app/globals.css`
 * (todo ele sob `[data-redesign="ligado"]`) a desenha como o protótipo v49.
 *
 * Desligada, o valor é `undefined` e o React não escreve atributo nenhum: o DOM
 * sai idêntico ao de antes.
 *
 * Este arquivo NUNCA importa `lib/redesign/chave.ts` (server-only). Página de
 * servidor lê `await redesignNaRequisicao()` e passa o booleano a `marcaDaIa`.
 */
export type PecaDaIa =
  | "pagina"
  | "cabecalho"
  | "titulo"
  | "descricao"
  | "conteudo"
  | "barra"
  | "acoes"
  | "filtros"
  | "pilulas"
  | "abas"
  | "avatar"
  | "cartao-topo"
  | "selos"
  | "cartao-rodape"
  | "grade-materiais";

export type MarcaDaIa = (peca: PecaDaIa) => PecaDaIa | undefined;

/** A regra pura, usável em página de servidor: ligada devolve a peça, desligada `undefined`. */
export function marcaDaIa(ligado: boolean): MarcaDaIa {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDaIa(): MarcaDaIa {
  return marcaDaIa(useRedesign());
}
