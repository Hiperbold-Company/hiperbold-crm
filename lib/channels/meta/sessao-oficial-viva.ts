/**
 * QUAL conexão oficial (WhatsApp Cloud / WABA) da organização uma rota está tratando.
 *
 * Desde 17/11/2026 a organização pode ter VÁRIAS conexões oficiais (uma por número). As rotas de
 * `/api/v1/channels/official/*` e a de modelos aceitam `channel_session_id` para dizer qual; a busca é
 * SEMPRE por id + `organization_id` da sessão de login + provider oficial + não arquivada. Um id de
 * outra organização, de outro provider ou já excluído cai no mesmo `null`, e a rota responde 404 sem
 * dizer qual dos três foi.
 *
 * Sem id, vale a conexão oficial MAIS ANTIGA da organização: é o comportamento da tela de hoje, que
 * ainda não manda o id. A fase B (tela em cartões) passa o id sempre. `order` + `limit(1)` e não
 * `maybeSingle` puro: com duas oficiais, o `maybeSingle` sozinho volta erro e a tela diria "não conectado".
 *
 * O cliente é de servidor e ignora a RLS: por isso o filtro de organização é explícito aqui.
 */
import { z } from "zod";

import { ARCHIVED_AT, queryTolerantToMissingArchived, type DbErrorLike } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import type { createAdminClient } from "@/lib/supabase/admin";

/** O id da conexão, quando a tela diz qual. */
export const idDaConexaoOficialSchema = z.string().uuid();

/**
 * Lê o id da conexão da query (`?id=` ou `?channel_session_id=`).
 * `undefined` = ausente (vale a mais antiga); `null` = presente e inválido (a rota responde 404).
 */
export function idDaConexaoNaQuery(url: URL): string | undefined | null {
  const bruto = url.searchParams.get("id") ?? url.searchParams.get("channel_session_id");
  if (bruto === null || bruto === "") return undefined;
  const parsed = idDaConexaoOficialSchema.safeParse(bruto);
  return parsed.success ? parsed.data : null;
}

export async function buscarSessaoOficialViva<T>(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  colunas: string,
  channelSessionId?: string | null,
): Promise<{ data: T | null; error: DbErrorLike | null }> {
  const consultar = () => {
    const q = admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META);
    // Com id, ele decide; sem id, a mais antiga (o comportamento de antes da fase B).
    return channelSessionId ? q.eq("id", channelSessionId) : q.order("created_at", { ascending: true }).limit(1);
  };
  const { data, error } = await queryTolerantToMissingArchived(
    () => consultar().is(ARCHIVED_AT, null).maybeSingle(),
    () => consultar().maybeSingle(),
  );
  return { data: (data as T | null) ?? null, error: error ?? null };
}
