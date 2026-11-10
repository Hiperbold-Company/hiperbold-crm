"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * O que o plano da organização inclui, para o editor de automação (D-227). Hoje só a automação por
 * comentário do Instagram (Pro não inclui). Sem provedor, vale "inclui": a recusa de verdade é a da
 * publicação e a do executor, no servidor.
 */
const ComentarioNoPlano = createContext<boolean>(true);

export function PlanoDoEditorProvider({
  comentarioDoInstagram,
  children,
}: {
  comentarioDoInstagram: boolean;
  children: ReactNode;
}) {
  return <ComentarioNoPlano.Provider value={comentarioDoInstagram}>{children}</ComentarioNoPlano.Provider>;
}

export function useComentarioDoInstagramNoPlano(): boolean {
  return useContext(ComentarioNoPlano);
}
