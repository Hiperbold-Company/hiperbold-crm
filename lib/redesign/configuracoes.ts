import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DE CONFIGURAÇÕES QUE O REDESIGN PINTA.
 *
 * As telas não foram copiadas: os componentes são os mesmos, com os mesmos
 * dados, permissões e `data-testid`. Com a chave ligada, cada peça ganha
 * `data-rd-configuracoes="<peça>"`, e o bloco `/* redesign: configuracoes *\/` de
 * `app/globals.css` (todo ele sob `[data-redesign="ligado"]`) a desenha como o
 * protótipo v49. Desligada, nada é escrito: o DOM sai idêntico ao de antes.
 *
 * Este arquivo NÃO importa `chave.ts` (é `server-only`). Página de SERVIDOR
 * decide com `await redesignNaRequisicao()` e usa `marcaDasConfiguracoes(ligado)`;
 * componente de cliente usa `useMarcaDasConfiguracoes()`. Sem `"use client"`
 * de propósito: a função pura tem de ser chamável no servidor (o hook só roda
 * em componente de cliente; no servidor `useRedesign` é só uma referência).
 */
export type PecaDasConfiguracoes =
  | "area"
  | "cabecalho"
  | "indice"
  | "secao-do-indice"
  | "grade-de-atalhos"
  | "atalho"
  | "cartao"
  | "linha"
  | "barra-de-salvar";

export type MarcaDasConfiguracoes = (
  peca: PecaDasConfiguracoes,
) => PecaDasConfiguracoes | undefined;

/** Pura, para página de servidor: `marcaDasConfiguracoes(await redesignNaRequisicao())`. */
export function marcaDasConfiguracoes(ligado: boolean): MarcaDasConfiguracoes {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDasConfiguracoes(): MarcaDasConfiguracoes {
  return marcaDasConfiguracoes(useRedesign());
}
