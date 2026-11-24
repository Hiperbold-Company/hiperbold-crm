"use client";

import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DO CHAT QUE O REDESIGN PINTA (item B4).
 *
 * A tela do Chat não foi copiada para uma versão nova: os componentes são os
 * mesmos, com os mesmos hooks, ações, permissões e `data-testid`. Com a chave
 * ligada, cada peça ganha um `data-rd-chat="<peça>"`, e é o bloco
 * `/* redesign: chat *\/` de `app/globals.css` (todo ele sob
 * `[data-redesign="ligado"]`) que a desenha como o protótipo v49.
 *
 * Desligada, `marca()` devolve `undefined` e o React não escreve atributo
 * nenhum: o DOM sai idêntico ao de antes, byte a byte.
 */
export type PecaDoChat =
  | "grade"
  | "lista"
  | "cabecalho-da-lista"
  | "mais-acoes"
  | "mais-acoes-lista"
  | "contato"
  | "contato-cartao"
  | "contato-avatar"
  | "contato-nome"
  | "contato-acoes"
  | "item-corpo"
  | "fila"
  | "titulo-da-lista"
  | "filtros"
  | "busca"
  | "abas"
  | "aba"
  | "aba-n"
  | "linha"
  | "item"
  | "marca-aberta"
  | "avatar"
  | "ponto"
  | "nome"
  | "hora"
  | "previa"
  | "nao-lidas"
  | "selos"
  | "conversa"
  | "barra-celular"
  | "cabecalho"
  | "identidade"
  | "nome-da-conversa"
  | "acoes"
  | "fio"
  | "dia"
  | "dia-linha"
  | "linha-busca"
  | "caixa-busca"
  | "seletores"
  | "bolha-linha"
  | "bolha"
  | "autor"
  | "rodape-da-bolha"
  | "nota-linha"
  | "nota"
  | "compositor"
  | "modos"
  | "modo-responder"
  | "modo-nota"
  | "caixa"
  | "campo"
  | "travado"
  | "ficha"
  | "ficha-topo"
  | "vazio";

export function useMarcaDoChat(): (peca: PecaDoChat) => PecaDoChat | undefined {
  const ligado = useRedesign();
  return (peca) => (ligado ? peca : undefined);
}

/** Quantas cores de avatar o protótipo tem (`--rd-chat-avatar-0..4`). */
export const CORES_DO_AVATAR = 5;

/**
 * A cor do avatar de um contato, estável pelo id: o mesmo contato tem a mesma
 * cor na lista, no cabeçalho e em qualquer recarga. Pura.
 */
export function corDoAvatar(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % CORES_DO_AVATAR;
}
