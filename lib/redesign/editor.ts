import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DO EDITOR VISUAL DE AUTOMAÇÕES QUE O REDESIGN PINTA (os nós).
 *
 * Mesmo desenho de `lib/redesign/conexoes.ts`: os componentes são os de sempre;
 * com a chave ligada cada peça ganha `data-rd-editor="<peça>"`, e o bloco
 * `/* redesign: editor *\/` de `app/globals.css` (todo ele sob
 * `[data-redesign="ligado"]`) a desenha no visual "Se / Então" do protótipo.
 * Desligada, o valor é `undefined` e o React não escreve atributo nenhum: DOM
 * idêntico ao de antes.
 *
 * O papel do nó (cor) é a peça do próprio cartão: `no-quando` (gatilho),
 * `no-se` (decide), `no-entao` (faz), `no-espera` e `no-fim`. O único texto novo é o
 * rótulo do papel (`papel`: Quando / Se / Então) em cima do título, só ligado.
 *
 * Este arquivo NUNCA importa `lib/redesign/chave.ts` (server-only).
 */
export type PecaDoEditor =
  | "canvas"
  | "no-quando"
  | "no-se"
  | "no-entao"
  | "no-espera"
  | "no-fim"
  | "icone"
  | "papel"
  | "titulo"
  | "resumo"
  | "ramos"
  | "erro";

export type MarcaDoEditor = (peca: PecaDoEditor) => PecaDoEditor | undefined;

/** A regra pura: ligada devolve a peça, desligada `undefined`. */
export function marcaDoEditor(ligado: boolean): MarcaDoEditor {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDoEditor(): MarcaDoEditor {
  return marcaDoEditor(useRedesign());
}

const SE = new Set(["condition", "ai_classify", "match_reply", "random_split", "instagram_check_follow"]);

/** O papel do nó pelo tipo: gatilho "Quando", decisão "Se", espera, fim, o resto "Então". */
export function pecaDoNo(tipo: string): PecaDoEditor {
  if (tipo === "trigger") return "no-quando";
  if (tipo === "wait") return "no-espera";
  if (tipo === "end") return "no-fim";
  return SE.has(tipo) ? "no-se" : "no-entao";
}
