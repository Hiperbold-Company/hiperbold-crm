/**
 * A CONVERSA DO DIRECT de uma execução que começou por um comentário.
 *
 * O comentário traz o IGSID de quem comentou (`vars.gatilho.autor_id`) e a
 * conexão que o recebeu (`vars.gatilho.channel_session_id`). No Direct, a
 * conversa dessa pessoa é a linha de `conversations` com
 * `channel_session_id` = a conexão e `provider_conversation_id` = o IGSID
 * (contrato do canal, seção 4). Ela só NASCE quando a pessoa responde a DM
 * (a resposta privada não aparece no CRM).
 *
 * Por isso a ligação é por CONSULTA, nunca gravada: a execução pode começar sem
 * conversa, estacionar esperando a resposta, e o primeiro bloco depois dela já
 * acha a conversa que o inbound criou. Nada a sincronizar, nada a migrar.
 *
 * Execução que não começou por comentário devolve `null` e segue a regra de
 * sempre (a conversa de WhatsApp do contato).
 *
 * A conversa também tem de ser DO CONTATO da execução (ou de um gêmeo dele,
 * `idsDoContatoEGemeos`): conexão e IGSID dizem de quem é o Direct, e o
 * `contact_id` garante que a execução de um contato nunca fala — nem lê
 * resposta — na conversa de outro, mesmo que uma linha fique com IGSID trocado.
 *
 * ⚠️ Service role: toda consulta filtra `organization_id` da EXECUÇÃO.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehCanalDoDirect } from "@/lib/channels/canal-do-direct";

export interface EscopoDoDirect {
  channelSessionId: string;
  /** IGSID de quem comentou: o `provider_conversation_id` da conversa. */
  autorId: string;
}

export interface ConversaDoDirect {
  id: string;
  provider: string | null;
  last_inbound_at: string | null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** O escopo do Direct desta execução, ou `null` quando ela não nasceu de um comentário. */
export function escopoDoDirect(vars: Record<string, unknown> | null | undefined): EscopoDoDirect | null {
  const g = vars?.gatilho as Record<string, unknown> | undefined;
  if (!g || g.tipo !== "instagram_comment") return null;
  const channelSessionId = texto(g.channel_session_id);
  const autorId = texto(g.autor_id);
  return channelSessionId && autorId ? { channelSessionId, autorId } : null;
}

/** As conversas (ids) do Direct desta pessoa nesta conexão. Vazio = a pessoa ainda não respondeu. */
export async function idsDasConversasDoDirect(
  admin: SupabaseClient,
  organizationId: string,
  escopo: EscopoDoDirect,
  contactIds: readonly string[],
): Promise<string[]> {
  const c = await conversaDoDirect(admin, organizationId, escopo, contactIds);
  return c ? [c.id] : [];
}

/**
 * A conversa do Direct, quando já existe e a conexão ainda é de Direct.
 * Lança em falha do banco (o efeito vira "envio falhou"; o relógio tenta de novo).
 */
export async function conversaDoDirect(
  admin: SupabaseClient,
  organizationId: string,
  escopo: EscopoDoDirect,
  /** O contato da execução e os gêmeos dele. Vazio = nenhuma conversa serve. */
  contactIds: readonly string[],
): Promise<ConversaDoDirect | null> {
  if (contactIds.length === 0) return null;
  const { data, error } = await admin
    .from("conversations")
    .select("id, last_inbound_at, is_group, channel_sessions:channel_session_id(provider)")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", escopo.channelSessionId)
    .eq("provider_conversation_id", escopo.autorId)
    .in("contact_id", [...contactIds])
    .eq("is_group", false)
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) throw new Error("conversa_indeterminada");
  const linha = ((data ?? []) as unknown as Array<{
    id: string;
    last_inbound_at: string | null;
    channel_sessions: { provider: string | null } | null;
  }>)[0];
  if (!linha || !ehCanalDoDirect(linha.channel_sessions?.provider)) return null;
  return {
    id: linha.id,
    provider: linha.channel_sessions?.provider ?? null,
    last_inbound_at: linha.last_inbound_at,
  };
}
