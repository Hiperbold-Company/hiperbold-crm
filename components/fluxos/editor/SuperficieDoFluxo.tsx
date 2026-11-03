"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";

/**
 * Em que superfície o canvas está aberto (follow-up, atendimento, automação).
 *
 * Os cartões do React Flow só enxergam o `data` do nó; para o cartão Fim dizer
 * "Concluída" na automação (e não o "Esgotado" do follow-up) a superfície chega
 * por contexto. Fora do canvas o padrão é o follow-up, como sempre foi.
 */
const Contexto = createContext<FollowupFlowSurface>("followup");

export function SuperficieDoFluxoProvider({
  surface,
  children,
}: {
  surface: FollowupFlowSurface;
  children: ReactNode;
}) {
  return <Contexto.Provider value={surface}>{children}</Contexto.Provider>;
}

export function useSuperficieDoFluxo(): FollowupFlowSurface {
  return useContext(Contexto);
}
