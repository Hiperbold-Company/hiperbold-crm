"use client";
import { createContext, useContext, type ReactNode } from "react";

/**
 * A chave do redesign (`REDESIGN_HIPERBOLD`) vista do CLIENTE. Quem decide é o
 * servidor (`lib/redesign/chave.ts`, no layout do app), que passa o booleano ao
 * `AppShell`; este contexto só o distribui às telas. Fora do provedor é sempre
 * `false`: tela nenhuma liga o redesign sozinha.
 */
const RedesignContext = createContext(false);

export function ProvedorDoRedesign({ ligado, children }: { ligado: boolean; children: ReactNode }) {
  return <RedesignContext.Provider value={ligado}>{children}</RedesignContext.Provider>;
}

export function useRedesign(): boolean {
  return useContext(RedesignContext);
}
