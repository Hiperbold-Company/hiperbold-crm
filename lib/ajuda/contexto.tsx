"use client";
import { createContext, useContext, type ReactNode } from "react";

/**
 * O endereço da central de ajuda desta instalação, para quem está fundo na
 * árvore (barra lateral, menu móvel, cabeçalho de cada tela).
 *
 * Quem lê `HELP_CENTER_URL` é o layout, no servidor, e o valor já chega aqui
 * normalizado (`baseDaCentralDeAjuda`). Sem provedor, ou com `null`, nenhum
 * link de ajuda aparece: o produto é white-label.
 */
const Ctx = createContext<string | null>(null);

export function ProvedorDaCentralDeAjuda({
  base,
  children,
}: {
  base: string | null;
  children: ReactNode;
}) {
  return <Ctx.Provider value={base}>{children}</Ctx.Provider>;
}

export function useBaseDaCentralDeAjuda(): string | null {
  return useContext(Ctx);
}
