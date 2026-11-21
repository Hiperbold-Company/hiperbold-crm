import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DE CONEXÕES QUE O REDESIGN PINTA.
 *
 * Mesmo desenho do Chat (`components/inbox/redesign/marca.ts`): os componentes
 * são os de sempre; com a chave ligada cada peça ganha
 * `data-rd-conexoes="<peça>"`, e o bloco `/* redesign: conexoes *\/` de
 * `app/globals.css` (todo ele sob `[data-redesign="ligado"]`) a desenha como o
 * protótipo v49. Desligada, o valor é `undefined` e o React não escreve
 * atributo nenhum: DOM idêntico ao de antes.
 *
 * Este arquivo NUNCA importa `lib/redesign/chave.ts` (server-only). A página,
 * que é de servidor, lê `redesignLigado()` e passa o booleano a
 * `marcaDasConexoes`.
 */
export type PecaDasConexoes =
  | "pagina"
  | "cabecalho"
  | "titulo"
  | "subtitulo"
  | "barra"
  | "busca"
  | "contador"
  | "criar"
  | "grade"
  | "cartao"
  | "cartao-topo"
  | "status"
  | "icone"
  | "tipo"
  | "nome"
  | "numero"
  | "rodape"
  | "gerenciar"
  | "vazio"
  | "erro"
  | "dialogo";

export type MarcaDasConexoes = (peca: PecaDasConexoes) => PecaDasConexoes | undefined;

/** A regra pura, usável em página de servidor: ligada devolve a peça, desligada `undefined`. */
export function marcaDasConexoes(ligado: boolean): MarcaDasConexoes {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDasConexoes(): MarcaDasConexoes {
  return marcaDasConexoes(useRedesign());
}
