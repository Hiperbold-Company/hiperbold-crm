/**
 * O MCP é recurso do plano (D-227): `mcp_req_min` 0 = o plano não inclui MCP
 * (Pro), número = o teto POR ORGANIZAÇÃO por minuto (Max 30, Scale 60), `null`
 * = sem limite do plano (Ilimitado, ou plano de antes da chave), e então
 * valem os tetos fixos de `rate-limit.ts`.
 *
 * ═══ Leitura do plano que falha NEGA ═══
 *
 * O resto do módulo de planos libera quando a leitura falha (erro de leitura
 * não pode derrubar a criação de um lead). Aqui é o contrário, por decisão do
 * dono do produto: MCP é recurso PAGO de liga/desliga, e liberar por erro
 * entregaria o recurso a quem não paga enquanto o banco oscila. A recusa é a
 * mesma do Pro, e o cache curto não guarda a falha (`limitesComCacheCurto`):
 * a próxima chamada tenta de novo.
 *
 * ═══ Por que na rota, e não por ferramenta ═══
 *
 * Plano sem MCP não tem ferramenta nenhuma a servir — nem a de privacidade,
 * que a organização suspensa ainda alcança: a LGPD continua atendida pela tela
 * e pela API de privacidade, e o MCP nunca foi parte do plano Pro. Recusar
 * antes de montar o servidor também poupa as leituras de módulos e
 * capacidades.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { limitesComCacheCurto } from "@/lib/billing/planos/limites-com-cache-curto";
import { CHAVE_DO_RECURSO, limiteDaChave } from "@/lib/billing/planos/limites";
import { logger } from "@/lib/logger";

import { McpAuthError } from "./auth";

export const PLANO_SEM_MCP_MSG = "O servidor MCP está disponível nos planos Max e Scale.";

/**
 * Recusa (`McpAuthError` -32002, HTTP 403, código `plano_sem_mcp`) quando o
 * plano da organização não inclui MCP ou a leitura falhou. Quando inclui,
 * devolve o teto por minuto do plano (`null` = sem teto do plano).
 */
export async function exigirMcpNoPlano(
  admin: SupabaseClient,
  organizationId: string,
): Promise<number | null> {
  const { limites, leituraFalhou } = await limitesComCacheCurto(admin, organizationId, logger);
  const valor = limiteDaChave(limites, CHAVE_DO_RECURSO.mcp);
  if (leituraFalhou || valor === 0) {
    // Mesma forma da recusa de organização suspensa (`validateBearerToken`):
    // -32002 / 403 com nome próprio.
    throw new McpAuthError(-32002, 403, PLANO_SEM_MCP_MSG, "plano_sem_mcp");
  }
  return valor;
}
