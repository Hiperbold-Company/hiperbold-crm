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
 * sempre (a conversa de WhatsApp do contato) — com UMA exceção: a que nasceu de
 * "Mensagem recebida" numa conversa de rede social (Messenger ou Direct). Nela a
 * conversa é a do próprio gatilho (`vars.gatilho.conversation_id`), e a marca
 * `vars.gatilho.canal_social` foi gravada no disparo (`gatilhos.handler.ts`),
 * depois de ler o provider da conexão daquela conversa. A marca só ESCOLHE o
 * caminho: a consulta abaixo confere de novo organização, contato, grupo e que
 * o canal ainda é social — uma marca errada dá "sem conversa", nunca outro canal.
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
import { plataformaDaConexao } from "@/lib/channels/listar-conexoes";

export interface EscopoDoDirect {
  channelSessionId: string;
  /** IGSID de quem comentou: o `provider_conversation_id` da conversa. */
  autorId: string;
}

/** Execução que nasceu de "Mensagem recebida" numa conversa de rede social: a conversa do gatilho. */
export interface EscopoDaMensagemSocial {
  conversationId: string;
}

/** Onde a execução conversa quando não é pelo WhatsApp: o Direct do comentário ou a conversa social do gatilho. */
export type EscopoDaConversaSocial = EscopoDoDirect | EscopoDaMensagemSocial;

/**
 * O rótulo do canal no histórico da execução (`detalhe.canal`). `rede_social`
 * quando o provider é social mas a conexão não diz a rede (social intermediado,
 * banco sem a coluna da plataforma).
 */
export const CANAIS_SOCIAIS = ["direct", "messenger", "rede_social"] as const;
export type CanalSocial = (typeof CANAIS_SOCIAIS)[number];

function ehCanalSocialDoRotulo(v: unknown): v is CanalSocial {
  return typeof v === "string" && (CANAIS_SOCIAIS as readonly string[]).includes(v);
}

/**
 * O rótulo para a conexão de uma conversa (gravado no disparo). `null` = não é
 * conversa de rede social (WhatsApp segue a regra de sempre). Pura.
 */
export function canalSocialDaConexao(
  provider: string | null | undefined,
  metaSocialPlatform: unknown,
): CanalSocial | null {
  if (!ehCanalDoDirect(provider)) return null;
  const plataforma = plataformaDaConexao(provider, metaSocialPlatform);
  if (plataforma === "instagram") return "direct";
  if (plataforma === "messenger") return "messenger";
  return "rede_social";
}

export function ehEscopoDaMensagem(e: EscopoDaConversaSocial): e is EscopoDaMensagemSocial {
  return "conversationId" in e;
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

/** A conversa do gatilho "Mensagem recebida" quando ele marcou canal social, senão `null`. */
function escopoDaMensagemSocial(vars: Record<string, unknown> | null | undefined): EscopoDaMensagemSocial | null {
  const g = vars?.gatilho as Record<string, unknown> | undefined;
  if (!g || g.tipo !== "message_received" || !ehCanalSocialDoRotulo(g.canal_social)) return null;
  const conversationId = texto(g.conversation_id);
  return conversationId ? { conversationId } : null;
}

/**
 * O escopo da conversa social da execução: o Direct do comentário
 * (`escopoDoDirect`) ou a conversa social do gatilho "Mensagem recebida".
 * `null` = segue pelo WhatsApp. É o que decide POR ONDE enviar e QUAL resposta
 * conta; o que é só do comentário (o piso que recua até o início da execução)
 * continua perguntando a `escopoDoDirect`.
 */
export function escopoDaConversaSocial(
  vars: Record<string, unknown> | null | undefined,
): EscopoDaConversaSocial | null {
  return escopoDoDirect(vars) ?? escopoDaMensagemSocial(vars);
}

/** O rótulo do canal social da execução (`direct` no comentário), ou `null` no WhatsApp. */
export function canalSocialDaExecucao(vars: Record<string, unknown> | null | undefined): CanalSocial | null {
  if (escopoDoDirect(vars)) return "direct";
  if (!escopoDaMensagemSocial(vars)) return null;
  return (vars?.gatilho as { canal_social: CanalSocial }).canal_social;
}

/** As conversas (ids) do Direct desta pessoa nesta conexão. Vazio = a pessoa ainda não respondeu. */
export async function idsDasConversasDoDirect(
  admin: SupabaseClient,
  organizationId: string,
  escopo: EscopoDaConversaSocial,
  contactIds: readonly string[],
): Promise<string[]> {
  const c = await conversaDoDirect(admin, organizationId, escopo, contactIds);
  return c ? [c.id] : [];
}

/**
 * A conversa do Direct (ou a conversa social do gatilho), quando já existe, é do
 * contato da execução e a conexão ainda é de rede social.
 * Lança em falha do banco (o efeito vira "envio falhou"; o relógio tenta de novo).
 */
export async function conversaDoDirect(
  admin: SupabaseClient,
  organizationId: string,
  escopo: EscopoDaConversaSocial,
  /** O contato da execução e os gêmeos dele. Vazio = nenhuma conversa serve. */
  contactIds: readonly string[],
): Promise<ConversaDoDirect | null> {
  if (contactIds.length === 0) return null;
  const base = admin
    .from("conversations")
    .select("id, last_inbound_at, is_group, channel_sessions:channel_session_id(provider)")
    .eq("organization_id", organizationId);
  // Mensagem recebida: a conversa do gatilho. Comentário: a do IGSID nesta conexão.
  const doEscopo = ehEscopoDaMensagem(escopo)
    ? base.eq("id", escopo.conversationId)
    : base.eq("channel_session_id", escopo.channelSessionId).eq("provider_conversation_id", escopo.autorId);
  const { data, error } = await doEscopo
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
