/**
 * Encerra no provedor as conexões de canal de UMA organização antes de ela ser excluída (migration 0959):
 * o que o produto já sabe fazer com segurança (`removerConexaoPorInstancia`: desliga o nosso webhook e apaga a
 * instância que o próprio CRM criou no servidor; a instância que o cliente trouxe com servidor e token dele só
 * perde o nosso webhook). É melhor esforço: erro em uma conexão vira contagem e log, e NUNCA impede a exclusão
 * (a linha da conexão some com a organização de qualquer jeito, e uma instância que sobrar no servidor é custo,
 * não vazamento).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { listarConexoesPorInstancia, removerConexaoPorInstancia } from "@/lib/channels/instancia";
import { logger } from "@/lib/logger";

export interface ResumoDasConexoes {
  encerradas: number;
  falhas: number;
}

export async function encerrarConexoesDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ResumoDasConexoes> {
  const resumo: ResumoDasConexoes = { encerradas: 0, falhas: 0 };
  let conexoes: { id: string }[] = [];
  try {
    conexoes = await listarConexoesPorInstancia(admin, organizationId);
  } catch (erro) {
    logger.warn("[exclusao] não deu para listar as conexões", {
      organization_id: organizationId,
      motivo: erro instanceof Error ? erro.message.slice(0, 120) : "erro",
    });
    return { encerradas: 0, falhas: 1 };
  }
  for (const c of conexoes) {
    try {
      const r = await removerConexaoPorInstancia(admin, organizationId, c.id);
      if (r.ok) resumo.encerradas++;
      else resumo.falhas++;
    } catch (erro) {
      resumo.falhas++;
      logger.warn("[exclusao] conexão não encerrada", {
        organization_id: organizationId,
        motivo: erro instanceof Error ? erro.message.slice(0, 120) : "erro",
      });
    }
  }
  return resumo;
}
