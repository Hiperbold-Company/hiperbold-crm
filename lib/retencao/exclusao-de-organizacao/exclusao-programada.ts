/**
 * Lê a exclusão programada de UMA organização para o aviso no app (migration 0959). Roda no layout de `/app`,
 * então NUNCA lança: leitura que falha vira "sem aviso" e um log, e o produto abre do mesmo jeito. Só devolve
 * programação ativa (`estado = 'programada'`) e ainda no futuro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export async function lerExclusaoProgramada(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ excluirEm: string } | null> {
  try {
    const { data, error } = await admin
      .from("org_exclusoes_programadas" as never)
      .select("excluir_em")
      .eq("organization_id", organizationId)
      .eq("estado", "programada")
      .maybeSingle();
    if (error) {
      logger.warn("[exclusao] não deu para ler a programação", {
        organization_id: organizationId,
        codigo: (error as { code?: string }).code ?? null,
      });
      return null;
    }
    const linha = data as unknown as { excluir_em: string } | null;
    if (!linha || Date.parse(linha.excluir_em) <= Date.now()) return null;
    return { excluirEm: linha.excluir_em };
  } catch {
    return null;
  }
}
