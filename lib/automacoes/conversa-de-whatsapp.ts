/**
 * A conversa pela qual a automação ENVIA: na execução que nasceu de um
 * comentário, a do Direct de quem comentou (`conversa-do-direct.ts`); na que
 * nasceu de "Mensagem recebida" numa conversa de rede social (Messenger ou
 * Direct), a própria conversa do gatilho — nunca o WhatsApp do contato; nas
 * demais, a de WhatsApp mais recente (não grupo) do contato e dos gêmeos de
 * telefone. É a MESMA para o bloco de mensagem (que envia por ela,
 * `efeitos/conversa.ts`) e para a condição "Janela de 24h aberta" (que pergunta
 * se dá para enviar por ela, `carregar-fatos.ts`) — duas buscas diferentes
 * responderiam sobre conversas diferentes, e a condição diria "aberta" para uma
 * conversa que o envio não usa. O texto da regra diz WhatsApp; no Direct a
 * pergunta é a mesma, sobre a conversa do Direct.
 *
 * Bloco com "Conexão" escolhida (`channel_session_id`): a conversa do contato
 * NAQUELA conexão (`conversaNaConexao`), nunca outra. Depois que ele envia, a
 * conversa vira a ativa da execução (`vars.conversa_ativa`) e vence as regras
 * acima para os blocos seguintes em branco (`escopoDaConversaSocial`).
 *
 * ⚠️ Service role: `orgId` vem da inscrição; toda consulta filtra `organization_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { transportaMensagem } from "@/lib/channels/capabilities";
import { ehCanalDeWhatsapp } from "@/lib/channels/canal-de-whatsapp";
import { estadoDaJanela } from "@/lib/channels/janela";

import {
  canalSocialDaConexao,
  conversaDoDirect,
  escopoDaConversaSocial,
  type CanalSocial,
} from "./conversa-do-direct";

export interface ConversaDoContato {
  id: string;
  provider: string | null;
  last_inbound_at: string | null;
}

export async function conversaDeWhatsappDoContato(
  admin: SupabaseClient,
  orgId: string,
  ids: readonly string[],
): Promise<ConversaDoContato | null> {
  const { data, error } = await admin
    .from("conversations")
    .select("id, last_inbound_at, is_group, channel_sessions:channel_session_id(provider)")
    .eq("organization_id", orgId)
    .in("contact_id", [...ids])
    .eq("is_group", false)
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .limit(20);
  if (error) throw new Error("conversa_indeterminada");
  const linhas = (data ?? []) as unknown as Array<{
    id: string;
    last_inbound_at: string | null;
    channel_sessions: { provider: string | null } | null;
  }>;
  const achada = linhas.find((l) => ehCanalDeWhatsapp(l.channel_sessions?.provider));
  return achada
    ? {
        id: achada.id,
        provider: achada.channel_sessions?.provider ?? null,
        last_inbound_at: achada.last_inbound_at,
      }
    : null;
}

/** A conversa do contato numa conexão escolhida, com o rótulo do canal (`null` = WhatsApp). */
export interface ConversaDaConexao extends ConversaDoContato {
  channel_session_id: string;
  canal: CanalSocial | null;
}

/**
 * A conversa individual mais recente (por `last_inbound_at`) do contato ou dos
 * gêmeos NESTA conexão, desta organização, num canal que transporta mensagem.
 * `null` = o contato não tem conversa nela; quem chama não procura em outra.
 * Lança em falha do banco.
 */
export async function conversaNaConexao(
  admin: SupabaseClient,
  orgId: string,
  channelSessionId: string,
  ids: readonly string[],
): Promise<ConversaDaConexao | null> {
  if (ids.length === 0) return null;
  const ler = (colunas: string) =>
    admin
      .from("conversations")
      .select(`id, last_inbound_at, is_group, channel_session_id, channel_sessions:channel_session_id(${colunas})`)
      .eq("organization_id", orgId)
      .eq("channel_session_id", channelSessionId)
      .in("contact_id", [...ids])
      .eq("is_group", false)
      .order("last_inbound_at", { ascending: false, nullsFirst: false })
      .limit(1);
  // A plataforma (Instagram/Messenger) só dá o rótulo do histórico; banco sem a
  // coluna (clone antigo) lê de novo só o provider.
  let { data, error } = await ler("provider, meta_social_platform");
  if (error && (error.message ?? "").includes("meta_social_platform")) ({ data, error } = await ler("provider"));
  if (error) throw new Error("conversa_indeterminada");
  const linha = ((data ?? []) as unknown as Array<{
    id: string;
    last_inbound_at: string | null;
    channel_sessions: { provider: string | null; meta_social_platform?: unknown } | null;
  }>)[0];
  const provider = linha?.channel_sessions?.provider ?? null;
  if (!linha || !transportaMensagem(provider)) return null;
  return {
    id: linha.id,
    provider,
    last_inbound_at: linha.last_inbound_at,
    channel_session_id: channelSessionId,
    canal: canalSocialDaConexao(provider, linha.channel_sessions?.meta_social_platform),
  };
}

/**
 * A conversa do envio desta execução (ver o cabeçalho): Direct quando a
 * execução nasceu de um comentário, a conversa social do gatilho quando nasceu
 * de mensagem recebida nela, senão WhatsApp. `null` = não há por onde
 * enviar. Lança em falha do banco.
 */
export async function conversaDoEnvio(
  admin: SupabaseClient,
  orgId: string,
  vars: Record<string, unknown> | null | undefined,
  ids: readonly string[],
  /** A "Conexão" escolhida no bloco; ausente = a dos blocos anteriores (ou a regra de sempre). */
  channelSessionId?: string,
): Promise<ConversaDoContato | null> {
  if (channelSessionId) return conversaNaConexao(admin, orgId, channelSessionId, ids);
  const escopo = escopoDaConversaSocial(vars);
  return escopo ? conversaDoDirect(admin, orgId, escopo, ids) : conversaDeWhatsappDoContato(admin, orgId, ids);
}

/**
 * O que a condição "Janela de 24h aberta" lê: `aberta` quando dá para mandar
 * texto livre agora (canal sem restrição de janela conta como aberta),
 * `fechada` quando só modelo aprovado sairia, `sem_conversa` quando o contato
 * não tem conversa de WhatsApp. Pura.
 */
export type JanelaDaConversa = "aberta" | "fechada" | "sem_conversa";

export function janelaDaConversa(conversa: ConversaDoContato | null, agora: Date): JanelaDaConversa {
  if (!conversa) return "sem_conversa";
  return estadoDaJanela(conversa.provider, conversa.last_inbound_at, agora).tipo === "fechada" ? "fechada" : "aberta";
}
