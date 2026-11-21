import "server-only";

import { env } from "@/lib/env";

/**
 * O redesign exclusivo da Hiperbold está ligado nesta instalação?
 *
 * Só o SERVIDOR lê (importa `@/lib/env`): o layout decide e passa o resultado
 * por prop/atributo. Nunca vira `NEXT_PUBLIC_*`, e nunca lança — qualquer
 * coisa diferente da grafia exata `ligado` é desligado.
 */
export function redesignLigado(): boolean {
  try {
    return valorLiga(env.REDESIGN_HIPERBOLD);
  } catch {
    return false;
  }
}

/** A regra pura: só a grafia exata `ligado` liga. */
export function valorLiga(valor: unknown): boolean {
  return valor === "ligado";
}
