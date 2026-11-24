import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DA AGENDA E DO RADAR QUE O REDESIGN PINTA.
 *
 * Com a chave ligada cada peça ganha `data-rd-agenda="<peça>"`, e o bloco
 * `/* redesign: agenda *\/` de `app/globals.css` (todo ele sob
 * `[data-redesign="ligado"]`) a desenha como o protótipo v49. Desligada, nada é
 * escrito: o DOM sai idêntico ao de antes. As peças do Radar levam o prefixo
 * `radar-`.
 *
 * Este arquivo NÃO importa `chave.ts` (é `server-only`). Página de SERVIDOR usa
 * `marcaDaAgenda(await redesignNaRequisicao())`; componente de cliente usa
 * `useMarcaDaAgenda()`. Sem `"use client"` de propósito.
 */
export type PecaDaAgenda =
  | "tela"
  | "cabecalho"
  | "barra"
  | "visoes"
  | "grade"
  | "compromisso"
  | "marcar-painel"
  | "marcar-contexto"
  | "detalhe"
  | "mes-celula"
  | "mes-celula-fora"
  | "mes-numero"
  | "mes-numero-hoje"
  | "mes-numero-fora"
  | "mes-chip"
  | "mes-mais"
  | "mes-fechado"
  | "radar-tela"
  | "radar-cabecalho"
  | "radar-aviso"
  | "radar-contagem"
  | "radar-lista"
  | "radar-item"
  | "radar-vazio";

export type MarcaDaAgenda = (peca: PecaDaAgenda) => PecaDaAgenda | undefined;

/** Pura, para página de servidor: `marcaDaAgenda(await redesignNaRequisicao())`. */
export function marcaDaAgenda(ligado: boolean): MarcaDaAgenda {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDaAgenda(): MarcaDaAgenda {
  return marcaDaAgenda(useRedesign());
}
