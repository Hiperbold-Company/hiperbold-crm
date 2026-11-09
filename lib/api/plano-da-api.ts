/**
 * A API REST por chave `dsk_` é recurso do plano (D-227): `acesso_api` 0 = o
 * plano não inclui (Pro); 1 ou `null` = inclui (Max, Scale, Ilimitado).
 *
 * Vale SÓ no caminho REST do bearer (`resolveAuthDual` e a implementação
 * inline de `app/api/v1/contacts`). O `/api/mcp` usa o mesmo
 * `validateBearerToken`, mas a trava dele é a do MCP (`lib/mcp/plano-do-mcp.ts`):
 * esta não é chamada lá, então um plano com MCP e sem API segue usando o MCP.
 * Sessão de navegador (cookie) não passa por aqui.
 *
 * ═══ Leitura do plano que falha NEGA ═══
 *
 * Recurso pago de liga/desliga: liberar por erro entregaria a API a quem não
 * paga enquanto o banco oscila. O cache curto não guarda a falha.
 */
import { limitesComCacheCurto } from "@/lib/billing/planos/limites-com-cache-curto";
import { recursoIncluidoNosLimites, type Limites } from "@/lib/billing/planos/limites";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { fail } from "./wrappers";

export const PLANO_SEM_API_MSG = "A API com chave de acesso está disponível nos planos Max e Scale.";

/** 402 `plano_sem_api` quando o plano não inclui a API (ou a leitura falhou); `null` = segue. */
export async function recusaDoPlanoSemApi(
  organizationId: string,
  requestId: string,
): Promise<Response | null> {
  const { limites, leituraFalhou } = await limitesComCacheCurto(createAdminClient(), organizationId, logger);
  if (!leituraFalhou && recursoIncluidoNosLimites(limites, "api")) return null;
  return fail("plano_sem_api", PLANO_SEM_API_MSG, 402, { requestId });
}

/** O que uma chave `dsk_` pode servir no plano: a API REST, o MCP, os dois ou nenhum. */
export interface RecursosDaChave {
  api: boolean;
  mcp: boolean;
}

/**
 * Leitura que falhou não inclui nada (mesma regra das duas travas). Usado pela
 * criação de chave (recusa quando não há nem API nem MCP) e pela tela.
 */
export function recursosDaChave(limites: Limites, leituraFalhou: boolean): RecursosDaChave {
  if (leituraFalhou) return { api: false, mcp: false };
  return {
    api: recursoIncluidoNosLimites(limites, "api"),
    mcp: recursoIncluidoNosLimites(limites, "mcp"),
  };
}
