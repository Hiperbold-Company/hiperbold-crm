/**
 * DEVOLVER O TURNO À IA quando a automação descarta a resposta do contato.
 *
 * Enquanto uma execução espera resposta numa conversa, o drain do agente cede
 * o turno (`uma-voz.ts`): a mensagem do contato é da automação. Se a automação
 * consome essa mensagem e TERMINA sem caminho ligado (resposta inválida com o
 * ramo "Resposta inválida" solto), ninguém responderia ao contato. Aqui o
 * despacho do agente é pedido de novo para a última mensagem da conversa — o
 * mesmo evento que a ingestão emite (`ai_agent.dispatch_requested`), com o
 * mesmo payload, e o drain decide como sempre (agente publicado, elegibilidade,
 * anti-backlog, rajada).
 *
 * Só devolve quando é seguro afirmar que a IA NÃO atendeu e NÃO vai atender
 * sozinha — senão seriam duas respostas:
 *  - o despacho daquela mensagem não está pendente nem em processamento (se
 *    está, o drain vai processá-lo agora, com a execução já terminada);
 *  - não há turno da IA (`job_queue` `inbound_turn`) do contato desde o início
 *    da espera: houve turno, a IA já está na conversa.
 *
 * Filtra `organization_id` em toda leitura (client de service role). Falha em
 * qualquer passo: não emite (o pior caso é o de antes desta função).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHAVE_DE_ORIGEM_AUTOMACAO } from "./teto-de-mensagens";

export const EVENTO_DE_DESPACHO_DO_AGENTE = "ai_agent.dispatch_requested";

export type DesfechoDaDevolucao =
  "emitido" | "sem_conversa" | "sem_inbound" | "despacho_em_curso" | "ia_ja_atendeu" | "falhou";

export async function devolverTurnoAoAgente(
  admin: SupabaseClient,
  pedido: { organizationId: string; enrollmentId: string; desde: string },
): Promise<DesfechoDaDevolucao> {
  const org = pedido.organizationId;
  try {
    // 1. A conversa em que esta execução falou (a mais recente).
    const { data: enviada, error: e1 } = await admin
      .from("messages")
      .select("conversation_id, created_at")
      .eq("organization_id", org)
      .eq("direction", "outbound")
      .eq(`metadata->${CHAVE_DE_ORIGEM_AUTOMACAO}->>enrollment_id`, pedido.enrollmentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (e1) return "falhou";
    const conversationId = (enviada as { conversation_id?: string } | null)?.conversation_id;
    if (!conversationId) return "sem_conversa";

    return await pedirTurnoDeNovo(admin, org, conversationId, pedido.desde, pedido.enrollmentId);
  } catch {
    return "falhou";
  }
}

/**
 * Passos 2 a 5, comuns às duas devoluções: a conversa (da organização, não
 * grupo), a última mensagem do contato desde `desde`, o despacho dela não
 * pendente, nenhum turno da IA desde `desde` — e só então o despacho de novo.
 */
async function pedirTurnoDeNovo(
  admin: SupabaseClient,
  org: string,
  conversationId: string,
  desde: string,
  enrollmentId: string,
): Promise<DesfechoDaDevolucao> {
    const { data: conversa, error: e2 } = await admin
      .from("conversations")
      .select("id, contact_id, channel_session_id, is_group")
      .eq("organization_id", org)
      .eq("id", conversationId)
      .maybeSingle();
    if (e2) return "falhou";
    const c = conversa as {
      id: string;
      contact_id: string | null;
      channel_session_id: string | null;
      is_group: boolean;
    } | null;
    if (!c || c.is_group || !c.contact_id || !c.channel_session_id) return "sem_conversa";

    // 2. A última mensagem do contato nessa conversa, desde o início da espera.
    const { data: ultima, error: e3 } = await admin
      .from("messages")
      .select("id, created_at")
      .eq("organization_id", org)
      .eq("conversation_id", c.id)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (e3) return "falhou";
    const inbound = ultima as { id: string; created_at: string } | null;
    if (!inbound || inbound.created_at < desde) return "sem_inbound";

    // 3. O despacho dela ainda vai rodar: o drain responde sozinho.
    const { data: despachos, error: e4 } = await admin
      .from("event_log")
      .select("status")
      .eq("organization_id", org)
      .eq("event_type", EVENTO_DE_DESPACHO_DO_AGENTE)
      .eq("entity_id", inbound.id);
    if (e4) return "falhou";
    if (
      ((despachos ?? []) as Array<{ status: string }>).some(
        (d) => d.status === "pending" || d.status === "processing",
      )
    ) {
      return "despacho_em_curso";
    }

    // 4. A IA já teve turno com o contato desde o início da espera.
    const { count, error: e5 } = await admin
      .from("job_queue")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("contact_id", c.contact_id)
      .eq("kind", "inbound_turn")
      .gte("created_at", desde);
    if (e5 || count === null) return "falhou";
    if (count > 0) return "ia_ja_atendeu";

    const { error: e6 } = await admin.rpc(
      "emit_event" as never,
      {
        p_event_type: EVENTO_DE_DESPACHO_DO_AGENTE,
        p_entity_kind: "message",
        p_entity_id: inbound.id,
        p_payload: {
          organization_id: org,
          conversation_id: c.id,
          contact_id: c.contact_id,
          channel_session_id: c.channel_session_id,
          inbound_message_id: inbound.id,
        },
        p_metadata: { source: "automacao.devolve_turno", enrollment_id: enrollmentId },
        p_organization_id: org,
      } as never,
    );
    return e6 ? "falhou" : "emitido";
}

/**
 * UMA VOZ no INÍCIO: a IA cedeu a mensagem que iniciou esta execução (gatilho
 * "mensagem recebida" de automação com bloco de conversa, `uma-voz.ts`), e a
 * execução TERMINOU sem enviar nada nesta conversa (um caminho sem Mensagem,
 * uma condição que saiu antes). O contato ficaria sem resposta: pede-se de
 * novo o turno da IA para a última mensagem dele, com as mesmas recusas da
 * devolução comum (despacho em curso, IA que já atendeu desde a mensagem).
 *
 * `desde` é o instante em que a mensagem do gatilho CHEGOU (lido da linha,
 * filtrando a organização e a conversa): o turno da IA que exista desde então
 * é a IA na conversa, e nada se devolve.
 */
export async function devolverTurnoDoInicio(
  admin: SupabaseClient,
  pedido: { organizationId: string; enrollmentId: string; conversationId: string; messageId: string },
): Promise<DesfechoDaDevolucao | "automacao_falou"> {
  const org = pedido.organizationId;
  try {
    const { data: falou, error: e1 } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", org)
      .eq("conversation_id", pedido.conversationId)
      .eq("direction", "outbound")
      .eq(`metadata->${CHAVE_DE_ORIGEM_AUTOMACAO}->>enrollment_id`, pedido.enrollmentId)
      .limit(1);
    if (e1) return "falhou";
    if ((falou ?? []).length > 0) return "automacao_falou";

    const { data: gatilho, error: e2 } = await admin
      .from("messages")
      .select("created_at")
      .eq("organization_id", org)
      .eq("conversation_id", pedido.conversationId)
      .eq("id", pedido.messageId)
      .maybeSingle();
    if (e2) return "falhou";
    const desde = (gatilho as { created_at?: string } | null)?.created_at;
    if (!desde) return "sem_inbound";
    return await pedirTurnoDeNovo(admin, org, pedido.conversationId, desde, pedido.enrollmentId);
  } catch {
    return "falhou";
  }
}
