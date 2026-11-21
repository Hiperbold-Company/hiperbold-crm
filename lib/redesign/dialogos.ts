import { useRedesign } from "@/lib/redesign/contexto";

/**
 * O INTERIOR DOS DIÁLOGOS DE CONEXÃO QUE O REDESIGN PINTA.
 *
 * A casca da tela e os cartões são da área `conexoes` (`lib/redesign/conexoes.ts`); aqui ficam as
 * peças de DENTRO dos diálogos: o Criar (lista de tipos e o caminho de conectar de cada um), o
 * pareamento por QR ou código, a escolha de páginas da Meta, o avançado da oficial e o Gerenciar,
 * que com a chave ligada vira gaveta lateral.
 *
 * Mesmo desenho das outras áreas: com a chave ligada cada peça ganha `data-rd-dialogos="<peça>"`,
 * e o bloco `/* redesign: dialogos *\/` de `app/globals.css` (todo ele sob
 * `[data-redesign="ligado"]`) a desenha como o protótipo v49. Desligada, o valor é `undefined` e o
 * React não escreve atributo nenhum: DOM idêntico ao de antes.
 *
 * Os nomes são curtos e REAPROVEITADOS entre arquivos (um "campo" é um campo em qualquer diálogo):
 * o CSS pinta a peça, não o componente.
 *
 * Este arquivo NUNCA importa `lib/redesign/chave.ts` (server-only).
 */
export type PecaDosDialogos =
  /** O Gerenciar como gaveta lateral (só existe com a chave ligada). */
  | "gaveta"
  | "cabecalho"
  | "titulo"
  | "descricao"
  | "corpo"
  /** A lista de tipos do Criar e cada tipo dela. */
  | "tipos"
  | "tipo"
  /** Um bloco de conteúdo (cartão) dentro do diálogo, com seu título e texto. */
  | "secao"
  | "secao-titulo"
  | "secao-texto"
  | "campo"
  | "passos"
  | "qr"
  | "codigo"
  /** Escolha entre formas de conectar: os cartões de modo e o par QR Code / código. */
  | "modos"
  | "modo"
  | "forma"
  | "aviso"
  /** Nota informativa (fundo de destaque suave), como o aviso de modo de teste do protótipo. */
  | "nota"
  | "acoes"
  | "rodape"
  | "lista"
  | "item"
  | "avancado";

export type MarcaDosDialogos = (peca: PecaDosDialogos) => PecaDosDialogos | undefined;

/** A regra pura, usável em página de servidor: ligada devolve a peça, desligada `undefined`. */
export function marcaDosDialogos(ligado: boolean): MarcaDosDialogos {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDosDialogos(): MarcaDosDialogos {
  return marcaDosDialogos(useRedesign());
}
