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
 * ⚠️ Service role: `orgId` vem da inscrição; toda consulta filtra `organization_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehCanalDeWhatsapp } from "@/lib/channels/canal-de-whatsapp";
import { estadoDaJanela } from "@/lib/channels/janela";

import { conversaDoDirect, escopoDaConversaSocial } from "./conversa-do-direct";

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
): Promise<ConversaDoContato | null> {
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
