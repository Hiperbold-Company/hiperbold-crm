import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DE AJUSTES (EQUIPE, PLANO E SEÇÕES DE CONFIGURAÇÕES) QUE O REDESIGN PINTA.
 *
 * Mesmo desenho de `lib/redesign/conexoes.ts`: os componentes são os de
 * sempre; com a chave ligada cada peça ganha `data-rd-ajustes="<peça>"`, e o
 * bloco `/* redesign: ajustes *\/` de `app/globals.css` (todo ele sob
 * `[data-redesign="ligado"]`) a desenha como o protótipo v49. Desligada, o
 * valor é `undefined` e o React não escreve atributo nenhum: DOM idêntico.
 *
 * Este arquivo NUNCA importa `lib/redesign/chave.ts` (server-only) e não tem
 * `"use client"`. Página de SERVIDOR usa `marcaDosAjustes(await redesignNaRequisicao())`;
 * componente de cliente usa `useMarcaDosAjustes()`.
 */
export type PecaDosAjustes =
  | "pagina"
  | "cabecalho"
  | "abas"
  | "lista"
  | "convites"
  | "secao"
  | "cartao-de-uso"
  | "linha-de-uso"
  | "barra-de-uso"
  | "cartao-do-plano";

export type MarcaDosAjustes = (peca: PecaDosAjustes) => PecaDosAjustes | undefined;

/** A regra pura, usável em página de servidor: ligada devolve a peça, desligada `undefined`. */
export function marcaDosAjustes(ligado: boolean): MarcaDosAjustes {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDosAjustes(): MarcaDosAjustes {
  return marcaDosAjustes(useRedesign());
}
