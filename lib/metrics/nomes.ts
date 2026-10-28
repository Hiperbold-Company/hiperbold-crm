/**
 * Nome de quem aparece nos rankings de Desempenho. Só `full_name` (o mínimo que
 * `/api/v1/team/assignable` já expõe), resolvido uma vez por pessoa. Sem service
 * role configurada (dev), degrada para nome nulo e a tela mostra o id curto.
 */
import { isServiceRoleConfigured } from "@/lib/audit";
import { resolveUserNames } from "@/lib/mcp/tools/_users";
import { createAdminClient } from "@/lib/supabase/admin";

export async function nomesDasPessoas(ids: Array<string | null | undefined>): Promise<Map<string, string | null>> {
  if (!isServiceRoleConfigured() || ids.every((id) => !id)) return new Map();
  return resolveUserNames(createAdminClient(), ids);
}

/** Acrescenta `name` a cada linha que tem `user_id`. */
export async function comNomes<T extends { user_id: string | null }>(linhas: T[]): Promise<Array<T & { name: string | null }>> {
  const nomes = await nomesDasPessoas(linhas.map((l) => l.user_id));
  return linhas.map((l) => ({ ...l, name: l.user_id ? (nomes.get(l.user_id) ?? null) : null }));
}
