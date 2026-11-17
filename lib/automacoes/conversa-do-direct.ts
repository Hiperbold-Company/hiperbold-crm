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
 * CONVERSA ATIVA (campo "Conexão" dos blocos Mensagem e Pergunta): quando um
 * bloco com a conexão escolhida envia, grava `vars.conversa_ativa` (a conversa,
 * a conexão e o rótulo do canal). Daí em diante ela vence o gatilho: os blocos
 * com "Conexão" em branco enviam por ela e a espera da resposta só conta o que
 * chega nela ("a conexão dos blocos anteriores"). A marca também só ESCOLHE: a
 * consulta confere organização, contato (ou gêmeo), grupo, a conexão gravada e
 * que o canal transporta mensagem. Sem a marca, tudo como antes.
 *
 * ⚠️ Service role: toda consulta filtra `organization_id` da EXECUÇÃO.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { transportaMensagem } from "@/lib/channels/capabilities";
import { ehCanalDoDirect } from "@/lib/channels/canal-do-direct";
import { plataformaDaConexao } from "@/lib/channels/listar-conexoes";

export interface EscopoDoDirect {
  channelSessionId: string;
  /** IGSID de quem comentou: o `provider_conversation_id` da conversa. */
  autorId: string;
}

/**
 * Execução que nasceu de "Mensagem recebida" numa conversa de rede social: a
 * conversa do gatilho. Com `conexao`, é a CONVERSA ATIVA (bloco com a conexão
 * escolhida): a conversa tem de estar nessa conexão, e o canal pode ser qualquer
 * um que transporte mensagem (inclusive WhatsApp).
 */
export interface EscopoDaMensagemSocial {
  conversationId: string;
  conexao?: string;
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

/** A conversa ativa gravada por um bloco com "Conexão" escolhida (`vars.conversa_ativa`). */
export interface ConversaAtiva {
  conversationId: string;
  channelSessionId: string;
  /** Rótulo do histórico; `null` = WhatsApp. */
  canal: CanalSocial | null;
}

/** A chave de `vars` onde mora a conversa ativa. */
export const CHAVE_DA_CONVERSA_ATIVA = "conversa_ativa";

/** O valor a mesclar em `vars` depois do envio por uma conexão escolhida. */
export function varsDaConversaAtiva(c: ConversaAtiva): Record<string, unknown> {
  return {
    [CHAVE_DA_CONVERSA_ATIVA]: {
      conversation_id: c.conversationId,
      channel_session_id: c.channelSessionId,
      canal: c.canal,
    },
  };
}

/** A conversa ativa da execução, ou `null` quando nenhum bloco escolheu conexão. */
export function conversaAtivaDasVars(vars: Record<string, unknown> | null | undefined): ConversaAtiva | null {
  const bruto = vars?.[CHAVE_DA_CONVERSA_ATIVA];
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const a = bruto as Record<string, unknown>;
  const conversationId = texto(a.conversation_id);
  const channelSessionId = texto(a.channel_session_id);
  if (!conversationId || !channelSessionId) return null;
  return { conversationId, channelSessionId, canal: ehCanalSocialDoRotulo(a.canal) ? a.canal : null };
}

/**
 * O piso da espera recua até o início da execução (o "quero" do Direct que
 * chega antes de a espera estacionar)? Só na execução do comentário e enquanto
 * nenhum bloco escolheu outra conexão: na conversa ativa o recuo leria como
 * resposta mensagem anterior à pergunta.
 */
export function recuaOPisoDoComentario(vars: Record<string, unknown> | null | undefined): boolean {
  return escopoDoDirect(vars) !== null && conversaAtivaDasVars(vars) === null;
}

/** A conversa do gatilho "Mensagem recebida" quando ele marcou canal social, senão `null`. */
function escopoDaMensagemSocial(vars: Record<string, unknown> | null | undefined): EscopoDaMensagemSocial | null {
  const g = vars?.gatilho as Record<string, unknown> | undefined;
  if (!g || g.tipo !== "message_received" || !ehCanalSocialDoRotulo(g.canal_social)) return null;
  const conversationId = texto(g.conversation_id);
  return conversationId ? { conversationId } : null;
}

/**
 * O escopo da conversa da execução: a CONVERSA ATIVA (bloco com "Conexão"
 * escolhida já enviou), senão o Direct do comentário (`escopoDoDirect`) ou a
 * conversa social do gatilho "Mensagem recebida". `null` = segue pelo WhatsApp
 * mais recente do contato. É o que decide POR ONDE enviar e QUAL resposta conta;
 * o piso que recua até o início da execução é só do comentário
 * (`recuaOPisoDoComentario`).
 */
export function escopoDaConversaSocial(
  vars: Record<string, unknown> | null | undefined,
): EscopoDaConversaSocial | null {
  const ativa = conversaAtivaDasVars(vars);
  if (ativa) return { conversationId: ativa.conversationId, conexao: ativa.channelSessionId };
  return escopoDoDirect(vars) ?? escopoDaMensagemSocial(vars);
}

/** O rótulo do canal social da execução (`direct` no comentário), ou `null` no WhatsApp. */
export function canalSocialDaExecucao(vars: Record<string, unknown> | null | undefined): CanalSocial | null {
  const ativa = conversaAtivaDasVars(vars);
  if (ativa) return ativa.canal;
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
 * contato da execução e a conexão ainda é de rede social. Na conversa ativa
 * (`escopo.conexao`), a conversa tem de estar nessa conexão e o canal só precisa
 * transportar mensagem.
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
    ? escopo.conexao
      ? base.eq("id", escopo.conversationId).eq("channel_session_id", escopo.conexao)
      : base.eq("id", escopo.conversationId)
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
  if (!linha) return null;
  const provider = linha.channel_sessions?.provider;
  const ativa = ehEscopoDaMensagem(escopo) && escopo.conexao !== undefined;
  if (ativa ? !transportaMensagem(provider) : !ehCanalDoDirect(provider)) return null;
  return {
    id: linha.id,
    provider: linha.channel_sessions?.provider ?? null,
    last_inbound_at: linha.last_inbound_at,
  };
}
