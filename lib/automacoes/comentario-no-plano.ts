/**
 * A automação por comentário do Instagram é recurso pago (D-227): `automacao_comentario_instagram` = 0 no Pro,
 * 1 no Max e no Scale. Duas portas usam esta regra: publicar a automação (`publicarFluxo`) e o executor dos
 * gatilhos (`aplicarGatilhosDeAutomacao`).
 *
 * ⚠️ AO CONTRÁRIO DOS TETOS, LEITURA QUE FALHA NEGA. Recurso liga/desliga pago não pode ficar ligado por
 * acidente porque o banco não respondeu. Fluxo já ativo numa organização que caiu para o Pro só para de
 * disparar: nada é apagado nem desativado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { recursoIncluido } from "@/lib/billing/planos/plano-da-organizacao";
import type { Logger } from "@/lib/agent-engine/obs/logger";

export const FRASE_COMENTARIO_SO_NO_MAX =
  "A automação por comentário do Instagram está disponível no plano Max.";

/** Algum gatilho do bloco Início do grafo é "Comentário no Instagram"? */
export function grafoUsaComentarioDoInstagram(graph: unknown): boolean {
  const nodes = (graph as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some((n) => {
    const no = n as { type?: unknown; config?: { triggers?: unknown } } | null;
    if (no?.type !== "trigger" || !Array.isArray(no.config?.triggers)) return false;
    return no.config.triggers.some((g) => (g as { kind?: unknown } | null)?.kind === "instagram_comment");
  });
}

/** O plano da organização inclui o recurso? Leitura que falhou = não inclui. Nunca lança. */
export async function comentarioDoInstagramNoPlano(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<boolean> {
  const r = await recursoIncluido(admin, organizationId, "comentario_instagram", log);
  return r.incluido && !r.leituraFalhou;
}
