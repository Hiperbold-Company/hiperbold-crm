/**
 * As chaves dos campos NÃO PÚBLICOS de uma organização (`custom_field_definitions.publico = false`,
 * migration 1015), para o recorte de `lib/campos/recorte-por-papel.ts`.
 *
 * Filtra `organization_id` explicitamente: o cliente pode ser o de service role. A falha de leitura
 * VOLTA declarada (`ok: false`), e quem chama decide — a tela responde 500 em vez de entregar o valor
 * ao papel errado; a automação tira todos os campos personalizados do contexto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export type ChavesRestritas = { ok: true; chaves: Set<string> } | { ok: false };

export async function chavesRestritasDaOrganizacao(
  supabase: SupabaseClient,
  organizationId: string,
  requestId?: string,
): Promise<ChavesRestritas> {
  const { data, error } = await supabase
    .from("custom_field_definitions")
    .select("key")
    .eq("organization_id", organizationId)
    .eq("publico", false);
  if (error) {
    logger.warn("[campos] não li as chaves restritas da organização", {
      organizationId,
      requestId,
      code: error.code,
      erro: error.message,
    });
    return { ok: false };
  }
  const chaves = new Set<string>();
  for (const linha of (data ?? []) as Array<{ key?: unknown }>) {
    if (typeof linha.key === "string") chaves.add(linha.key.toLowerCase());
  }
  return { ok: true, chaves };
}
