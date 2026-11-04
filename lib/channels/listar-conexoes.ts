/**
 * Os canais de MENSAGEM (WhatsApp) da organização — só LEITURA (`channel_sessions`).
 *
 * Quem chama: `GET /api/v1/channel-sessions` (sessão OU token `dsk_…`) e a tool MCP `crm_list_channel_sessions`.
 *
 * ⚠️ SEM SEGREDO, POR CONSTRUÇÃO: as colunas pedidas são uma lista fixa (`CHANNEL_COLUMNS`) e não incluem o token
 * do número, o endereço de webhook nem nada que autentique o canal. Criar, reconectar, parear e apagar número
 * continuam só pela sessão (exigem o segundo fator e falam com o provedor).
 *
 * Cada linha leva `plataforma` (`whatsapp` | `instagram` | `messenger` | `null`), derivada de `provider` e de
 * `meta_social_platform`; a coluna crua não sai.
 *
 * ⚠️ A organização é a que a porta resolveu (sessão/linha do token), com filtro explícito: o cliente de uma chave
 * é service role e BYPASSA a RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived, type DbErrorLike } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META_SOCIAL, PROVIDERS_DE_MENSAGEM, ehCanalSocial } from "@/lib/channels/capabilities";
import { ehPlataformaMetaSocial } from "@/lib/channels/meta-social/constantes";

export const CHANNEL_COLUMNS =
  "id, provider, waha_session_name, display_name, phone_number, status, status_reason, last_health_check_at, last_status_change_at, daily_message_limit, is_warmup_complete, created_at, metadata";

/** Lida só para derivar `plataforma`; não sai na resposta. */
const COLUNA_DA_PLATAFORMA = "meta_social_platform";

/** A rede da conexão: `whatsapp`, `instagram`, `messenger`, ou `null` quando a linha não diz. */
export type PlataformaDaConexao = "whatsapp" | "instagram" | "messenger" | null;

/**
 * `instagram`/`messenger` para o canal social oficial (a coluna
 * `meta_social_platform`); `whatsapp` para os canais de número; `null` para o
 * social intermediado (a rede dele não está numa coluna) e para quem não se sabe.
 */
export function plataformaDaConexao(provider: string | null | undefined, metaSocialPlatform: unknown): PlataformaDaConexao {
  if (provider === CHANNEL_PROVIDER_META_SOCIAL) return ehPlataformaMetaSocial(metaSocialPlatform) ? metaSocialPlatform : null;
  if (ehCanalSocial(provider)) return null;
  return (PROVIDERS_DE_MENSAGEM as readonly string[]).includes(provider ?? "") ? "whatsapp" : null;
}

/** Uma linha da listagem: as colunas de `CHANNEL_COLUMNS` mais a `plataforma` derivada. */
export interface ConexaoDeMensagem {
  id: string;
  provider: string;
  waha_session_name: string | null;
  display_name: string | null;
  phone_number: string | null;
  status: string;
  status_reason: string | null;
  last_health_check_at: string | null;
  last_status_change_at: string | null;
  daily_message_limit: number;
  is_warmup_complete: boolean | null;
  created_at: string;
  /**
   * Só `disabled` (o selo "Pausado", #2318). O `metadata` cru guarda configuração que não é de todo membro
   * (`ai_test_phone_numbers`), então a listagem o reduz AQUI — vale para a rota e para a tool MCP.
   */
  metadata: { disabled: boolean };
  plataforma: PlataformaDaConexao;
}

/** O banco ainda não tem `meta_social_platform` (clone sem a migration do canal social). */
function semColunaDaPlataforma(error: DbErrorLike | null): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204") && (error.message ?? "").includes(COLUNA_DA_PLATAFORMA);
}

export async function listarConexoesDeMensagem(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ data: ConexaoDeMensagem[] | null; error: DbErrorLike | null; schemaOutdated: boolean }> {
  const base = (colunas: string) =>
    supabase
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      // Só canal de MENSAGEM. A linha de chamada de voz (spec 18) mora na mesma tabela, tem card próprio em Conexões
      // e não tem `waha_session_name` nem telefone: entrando aqui, viraria um número a mais no seletor do inbox.
      .in("provider", [...PROVIDERS_DE_MENSAGEM]);
  // Canais arquivados sobrevivem só como âncora das FKs RESTRICT: para o usuário eles foram excluídos. Tolerante à
  // coluna ausente (clone sem a migration 0106): sem a coluna, nada está arquivado e a lista sem o filtro é a certa.
  const consultar = (colunas: string) =>
    queryTolerantToMissingArchived(
      () => base(colunas).is(ARCHIVED_AT, null).order("created_at", { ascending: true }),
      () => base(colunas).order("created_at", { ascending: true }),
    );
  let r = await consultar(`${CHANNEL_COLUMNS}, ${COLUNA_DA_PLATAFORMA}`);
  let schemaOutdated = r.schemaOutdated;
  // Sem a coluna da plataforma, a lista sai igual e a rede social oficial fica `null` (com o aviso de schema).
  if (semColunaDaPlataforma(r.error)) {
    r = await consultar(CHANNEL_COLUMNS);
    schemaOutdated = true;
  }
  if (r.error) return { data: null, error: r.error, schemaOutdated: r.schemaOutdated };
  const data = ((r.data ?? []) as unknown as Record<string, unknown>[]).map((linha): ConexaoDeMensagem => {
    const { [COLUNA_DA_PLATAFORMA]: plataformaMeta, metadata: bruto, ...resto } = linha;
    const m = bruto && typeof bruto === "object" ? (bruto as Record<string, unknown>) : undefined;
    return {
      ...(resto as Omit<ConexaoDeMensagem, "plataforma" | "metadata">),
      metadata: { disabled: m?.disabled === true },
      plataforma: plataformaDaConexao(resto.provider as string | null, plataformaMeta),
    };
  });
  return { data, error: null, schemaOutdated: schemaOutdated || r.schemaOutdated };
}
