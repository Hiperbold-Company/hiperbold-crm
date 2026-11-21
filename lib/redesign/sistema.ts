import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DAS PÁGINAS DE SISTEMA E PÚBLICAS QUE O REDESIGN PINTA.
 *
 * Vale para 403, 404, 500, 503, conta suspensa, acesso revogado, fim do
 * acompanhamento, exclusão de dados, termos e privacidade. Mesmo desenho de
 * `lib/redesign/conexoes.ts`: as páginas são as de sempre; com a chave ligada
 * cada peça ganha `data-rd-sistema="<peça>"`, e o bloco
 * `/* redesign: sistema *\/` de `app/globals.css` (todo ele sob
 * `[data-redesign="ligado"]`) a desenha como o protótipo v49. Desligada, o
 * valor é `undefined` e o React não escreve atributo nenhum: DOM idêntico.
 *
 * Quase todas estas páginas ficam FORA de `/app`, onde o provedor do redesign
 * não existe. Por isso a página de servidor lê `redesignLigado()` e passa o
 * booleano a `marcaDoSistema`. Este arquivo NUNCA importa
 * `lib/redesign/chave.ts` (server-only).
 */
export type PecaDoSistema =
  | "pagina"
  | "cartao"
  | "titulo"
  | "texto"
  | "destaque"
  | "acoes"
  | "aviso"
  | "marca"
  | "cabecalho"
  | "voltar"
  | "documento"
  | "codigo"
  | "erro-id";

export type MarcaDoSistema = (peca: PecaDoSistema) => PecaDoSistema | undefined;

/** A regra pura, usável em página de servidor: ligada devolve a peça, desligada `undefined`. */
export function marcaDoSistema(ligado: boolean): MarcaDoSistema {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDoSistema(): MarcaDoSistema {
  return marcaDoSistema(useRedesign());
}
