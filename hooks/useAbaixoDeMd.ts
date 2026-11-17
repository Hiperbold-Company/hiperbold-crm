"use client";

import { useSyncExternalStore } from "react";

const CONSULTA = "(max-width: 767px)";

function assinar(aviso: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(CONSULTA);
  mql.addEventListener("change", aviso);
  return () => mql.removeEventListener("change", aviso);
}

function agora(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(CONSULTA).matches;
}

/**
 * Verdadeiro abaixo do `md` (768px do Tailwind). No servidor devolve `false`:
 * o HTML do SSR é o do computador, e só o celular troca depois de hidratar.
 */
export function useAbaixoDeMd(): boolean {
  return useSyncExternalStore(assinar, agora, () => false);
}
