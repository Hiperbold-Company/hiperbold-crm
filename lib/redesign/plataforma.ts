import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DO PAINEL DA PLATAFORMA (`/admin/*`) QUE O REDESIGN PINTA.
 *
 * Mesmo desenho de `lib/redesign/conexoes.ts`: os componentes são os de sempre;
 * com a chave ligada cada peça ganha `data-rd-plataforma="<peça>"`, e o bloco
 * `/* redesign: plataforma *\/` de `app/globals.css` (todo ele sob
 * `[data-redesign="ligado"]`) a desenha como o protótipo v49. Desligada, o
 * valor é `undefined` e o React não escreve atributo nenhum: DOM idêntico.
 *
 * O painel fica FORA de `/app`, então o provedor do redesign não o envolve por
 * conta própria: `app/admin/(protected)/layout.tsx` (servidor) lê
 * `await redesignNaRequisicao()` e monta o `ProvedorDoRedesign`.
 *
 * Este arquivo NUNCA importa `lib/redesign/chave.ts` (server-only).
 */
export type PecaDaPlataforma =
  | "casca"
  | "menu"
  | "menu-topo"
  | "menu-marca"
  | "menu-lista"
  | "menu-item"
  | "menu-rodape"
  | "topo"
  | "conteudo"
  | "cabecalho"
  | "titulo"
  | "subtitulo"
  | "criar";

export type MarcaDaPlataforma = (peca: PecaDaPlataforma) => PecaDaPlataforma | undefined;

/** A regra pura, usável em página de servidor: ligada devolve a peça, desligada `undefined`. */
export function marcaDaPlataforma(ligado: boolean): MarcaDaPlataforma {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDaPlataforma(): MarcaDaPlataforma {
  return marcaDaPlataforma(useRedesign());
}
