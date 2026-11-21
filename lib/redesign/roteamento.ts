import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DO ROTEAMENTO QUE O REDESIGN PINTA.
 *
 * Vale para o editor de roteador, os resultados do roteamento, o dossiê do
 * follow-up e o cabeçalho dos fluxos de atendimento. Os componentes são os de
 * sempre; com a chave ligada cada peça ganha `data-rd-roteamento="<peça>"`, e o
 * bloco `/* redesign: roteamento *\/` de `app/globals.css` (todo ele sob
 * `[data-redesign="ligado"]`) a desenha como o protótipo v49. Desligada, o valor
 * é `undefined` e o React não escreve atributo nenhum: DOM idêntico ao de antes.
 *
 * Este arquivo NUNCA importa `lib/redesign/chave.ts` (server-only). Página de
 * servidor lê `redesignLigado()` e passa o booleano a `marcaDoRoteamento`.
 */
export type PecaDoRoteamento =
  | "pagina"
  | "area"
  | "area-cabecalho"
  | "cabecalho"
  | "titulo"
  | "descricao"
  | "voltar"
  | "estado"
  | "secao"
  | "secao-titulo"
  | "intencao"
  | "teste"
  | "filtros"
  | "resumo"
  | "indicador"
  | "caso"
  | "vazio"
  | "faixa-erro"
  | "dossie-resumo"
  | "dossie-secao"
  | "dossie-acoes";

export type MarcaDoRoteamento = (peca: PecaDoRoteamento) => PecaDoRoteamento | undefined;

/** A regra pura, usável em página de servidor: ligada devolve a peça, desligada `undefined`. */
export function marcaDoRoteamento(ligado: boolean): MarcaDoRoteamento {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDoRoteamento(): MarcaDoRoteamento {
  return marcaDoRoteamento(useRedesign());
}
