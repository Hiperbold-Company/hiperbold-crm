import "server-only";

import { cache } from "react";

import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O redesign exclusivo da Hiperbold está ligado NESTA requisição?
 *
 * Regra: chave geral da instalação (`REDESIGN_HIPERBOLD=ligado`) OU
 * `organizations.settings.redesign.ligado === true` da empresa ativa de quem
 * está logado (fase 1: só o admin da plataforma liga, empresa por empresa).
 *
 * Só o SERVIDOR lê: o layout e as páginas decidem e passam o resultado por
 * prop/atributo. Nunca vira `NEXT_PUBLIC_*`, e nunca lança — sem sessão, sem
 * empresa ou qualquer falha é desligado, porque a raiz (`app/layout.tsx`)
 * depende dela em todas as telas. O `cache` do React dá UMA resposta por
 * requisição: a raiz, os `ProvedorDoRedesign` e cada tela leem a mesma.
 */
export const redesignNaRequisicao = cache(async (): Promise<boolean> => {
  try {
    if (valorLiga(env.REDESIGN_HIPERBOLD)) return true;

    const user = await loadAuthUser();
    if (!user) return false;

    // A empresa vem da sessão (fonte confiável), nunca de input.
    const org = await orgAtivaSemPortao(user);
    if (!org) return false;

    const { data, error } = await createAdminClient()
      .from("organizations")
      .select("settings")
      .eq("id", org.orgId)
      .maybeSingle();
    if (error) return false;
    return redesignDaEmpresa((data as { settings?: unknown } | null)?.settings);
  } catch {
    // Inclui o redirect do Next (NEXT_REDIRECT) lançado por `orgAtivaSemPortao`
    // numa sessão de suporte encerrada: a própria página fará o redirect.
    return false;
  }
});

/** A regra pura da empresa: só `settings.redesign.ligado === true` liga. */
export function redesignDaEmpresa(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const redesign = (settings as { redesign?: unknown }).redesign;
  if (!redesign || typeof redesign !== "object") return false;
  return (redesign as { ligado?: unknown }).ligado === true;
}

/**
 * Só a chave geral da instalação. Interna a este módulo e ao teste dele: fora
 * daqui toda tela usa `redesignNaRequisicao()` (cerca em
 * `tests/unit/redesign-uma-resposta-por-requisicao.test.ts`).
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
