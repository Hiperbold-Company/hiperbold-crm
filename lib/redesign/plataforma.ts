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
  | "criar"
  // onda 5: o molde do v49 em toda tela de /admin
  | "filtros"
  | "tabela"
  | "nome"
  | "avatar"
  | "voltar"
  | "cabecalho-da-empresa"
  | "selo"
  | "grade-de-cartoes"
  | "formulario";

export type MarcaDaPlataforma = (peca: PecaDaPlataforma) => PecaDaPlataforma | undefined;

/** A regra pura, usável em página de servidor: ligada devolve a peça, desligada `undefined`. */
export function marcaDaPlataforma(ligado: boolean): MarcaDaPlataforma {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDaPlataforma(): MarcaDaPlataforma {
  return marcaDaPlataforma(useRedesign());
}

/**
 * As iniciais do avatar das listas (onda 5, v49): até duas letras, das duas
 * primeiras palavras do nome que a linha JÁ mostra. Nome vazio devolve "".
 * Só é chamado com a chave ligada; o avatar é decorativo (`aria-hidden`).
 */
export function iniciaisDoNome(nome: string | null | undefined): string {
  const palavras = (nome ?? "").trim().split(/\s+/).filter(Boolean);
  return palavras
    .slice(0, 2)
    .map((p) => Array.from(p)[0] ?? "")
    .join("")
    .toLocaleUpperCase("pt-BR");
}
