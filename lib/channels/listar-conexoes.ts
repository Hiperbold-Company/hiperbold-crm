/**
 * Os canais de MENSAGEM (WhatsApp) da organização — só LEITURA (`channel_sessions`).
 *
 * Quem chama: `GET /api/v1/channel-sessions` (sessão OU token `dsk_…`) e a tool MCP `crm_list_channel_sessions`.
 *
 * ⚠️ SEM SEGREDO, POR CONSTRUÇÃO: as colunas pedidas são uma lista fixa (`CHANNEL_COLUMNS`) e não incluem o token
 * do número, o endereço de webhook nem nada que autentique o canal. Criar, reconectar, parear e apagar número
 * continuam só pela sessão (exigem o segundo fator e falam com o provedor).
 *
 * ⚠️ A organização é a que a porta resolveu (sessão/linha do token), com filtro explícito: o cliente de uma chave
 * é service role e BYPASSA a RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";

export const CHANNEL_COLUMNS =
  "id, provider, waha_session_name, display_name, phone_number, status, status_reason, last_health_check_at, last_status_change_at, daily_message_limit, is_warmup_complete, created_at";

export async function listarConexoesDeMensagem(supabase: SupabaseClient, organizationId: string) {
  const base = () =>
    supabase
      .from("channel_sessions")
      .select(CHANNEL_COLUMNS)
      .eq("organization_id", organizationId)
      // Só canal de MENSAGEM. A linha de chamada de voz (spec 18) mora na mesma tabela, tem card próprio em Conexões
      // e não tem `waha_session_name` nem telefone: entrando aqui, viraria um número a mais no seletor do inbox.
      .in("provider", [...PROVIDERS_DE_MENSAGEM]);
  // Canais arquivados sobrevivem só como âncora das FKs RESTRICT: para o usuário eles foram excluídos. Tolerante à
  // coluna ausente (clone sem a migration 0106): sem a coluna, nada está arquivado e a lista sem o filtro é a certa.
  return queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).order("created_at", { ascending: true }),
    () => base().order("created_at", { ascending: true }),
  );
}
