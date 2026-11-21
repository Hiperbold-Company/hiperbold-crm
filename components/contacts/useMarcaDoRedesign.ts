"use client";
import { useCallback } from "react";

import { useRedesign } from "@/lib/redesign/contexto";

/**
 * As marcas do redesign na área Contatos (lista, ficha, exclusão, Campanhas e
 * Importações). Devolve uma função `rd(peça)` para o atributo
 * `data-rd-contatos`: com a chave LIGADA, o nome da peça; DESLIGADA,
 * `undefined` — e o React não escreve atributo nenhum. Quem desenha é o bloco
 * `redesign: contatos` no fim de `app/globals.css`, todo escopado por
 * `[data-redesign="ligado"]`. Cobrado por `tests/unit/redesign-contatos.test.tsx`.
 */
export function useMarcaDoRedesign(): (peca: string) => string | undefined {
  const ligado = useRedesign();
  return useCallback((peca: string) => (ligado ? peca : undefined), [ligado]);
}
