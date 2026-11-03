/**
 * UMA VOZ SÓ enquanto uma automação espera a resposta do contato.
 *
 * A IA cede o turno de uma mensagem quando, ao mesmo tempo:
 *  (a) há execução de automação em `waiting_reply` — status ao qual a raia
 *      `automacao` só chega por bloco de conversa (mensagem com opções,
 *      pergunta, espera "até responder"); e
 *  (b) a mensagem chegou na MESMA conversa em que essa execução enviou
 *      (`messages.metadata.origem_automacao.enrollment_id`). Um contato que
 *      escreve pelo Instagram ou por outro número não cala a IA: a automação
 *      falou num canal, e é dele que ela espera.
 *
 * A espera "até responder" sem nenhum envio da execução naquela conversa não
 * cala a IA: não há pergunta da automação a que a IA estaria respondendo por cima.
 *
 * Contato sem resposta: quando a automação consome a mensagem e termina sem
 * caminho ligado ("Resposta inválida" solta), o motor devolve o turno à IA
 * (`devolver-turno.ts`).
 *
 * Fail-open, como `deveCederTurnoAoRetorno`: consulta que falha não cala o
 * agente — o contato sem ninguém é pior que duas vozes pontuais.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { AUTOMACAO_GATILHOS_HANDLER_KEY } from "./chaves";

export async function automacaoEsperaRespostaNaConversa(
  pool: Pick<pg.Pool, "query">,
  pedido: { organizationId: string; conversationId: string },
): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `select 1 from followup_enrollments e
        where e.organization_id = $1
          and e.lane = 'automacao' and e.status = 'waiting_reply'
          and exists (
            select 1 from messages m
             where m.organization_id = $1
               and m.conversation_id = $2
               and m.direction = 'outbound'
               and m.metadata->'origem_automacao'->>'enrollment_id' = e.id::text
          )
        limit 1`,
      [pedido.organizationId, pedido.conversationId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * A mesma pergunta pelo PostgREST, para o handler dos gatilhos (que roda no
 * dreno do `event_log`, sem `pg`): a mensagem chegou numa conversa em que uma
 * execução de automação ESPERANDO resposta enviou? Então ela é a resposta
 * daquela automação, e não "mensagem recebida" para iniciar outras.
 *
 * Diferente da versão do drain, aqui erro LANÇA: o handler devolve `error` e o
 * evento volta para a fila. Falhar aberto iniciaria automação em cima de uma
 * resposta — duas vozes de automação, que é o que a regra existe para evitar.
 */
export async function automacaoEsperaRespostaNaConversaSupabase(
  admin: SupabaseClient,
  pedido: { organizationId: string; conversationId: string },
): Promise<boolean> {
  const { data: enviadas, error } = await admin
    .from("messages")
    .select("metadata")
    .eq("organization_id", pedido.organizationId)
    .eq("conversation_id", pedido.conversationId)
    .eq("direction", "outbound")
    .not("metadata->origem_automacao", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  const ids = [
    ...new Set(
      ((enviadas ?? []) as Array<{ metadata: unknown }>).flatMap((m) => {
        const origem = (m.metadata as { origem_automacao?: { enrollment_id?: unknown } } | null)?.origem_automacao;
        return typeof origem?.enrollment_id === "string" ? [origem.enrollment_id] : [];
      }),
    ),
  ];
  if (ids.length === 0) return false;
  const { data: esperando, error: e2 } = await admin
    .from("followup_enrollments")
    .select("id")
    .eq("organization_id", pedido.organizationId)
    .eq("lane", "automacao")
    .eq("status", "waiting_reply")
    .in("id", ids)
    .limit(1);
  if (e2) throw new Error(e2.message);
  return (esperando ?? []).length > 0;
}

/**
 * Quanto o turno da IA espera o handler dos gatilhos decidir se uma automação
 * assume a mensagem. O worker drena o `event_log` a cada ~2 s; passado isto o
 * turno segue (fail-open: o contato sem ninguém é pior que duas vozes).
 */
export const TETO_DA_ESPERA_PELO_GATILHO_MS = 30_000;

export type DecisaoDoGatilhoDeMensagem = "ceder" | "esperar" | "seguir";

/**
 * UMA VOZ no INÍCIO: a mensagem que acabou de chegar iniciou uma automação com
 * bloco de conversa (Mensagem ou Pergunta)? Então a automação responde e a IA
 * não — `ceder`. Automação sem bloco de conversa não cala a IA.
 *
 * A ordem dos dois consumidores não é garantida: o turno nasce de
 * `ai_agent.dispatch_requested` (drain do agente) e a automação do
 * `message.received` (dreno do `event_log`, handler `automacao-gatilhos.v1`).
 * Por isso a resposta é EXATA e em três tempos:
 *
 *  1. o handler já consumiu o `message.received` desta mensagem → cede se
 *     existe execução nascida DELE (`origin_event_id`) cujo grafo tem bloco de
 *     conversa; senão segue (o gatilho não casou, ou a automação foi recusada
 *     por reentrada, espera, teto — e então ninguém falou);
 *  2. ainda não consumiu, mas há automação ATIVA com gatilho "mensagem
 *     recebida" e bloco de conversa → `esperar` (o drain adia o turno alguns
 *     segundos, até o teto);
 *  3. qualquer outro caso (sem automação armada, evento não achado, teto
 *     vencido, consulta que falha) → `seguir`.
 */
export async function decisaoDoGatilhoDeMensagem(
  pool: Pick<pg.Pool, "query">,
  pedido: { organizationId: string; messageId: string; agora?: Date },
): Promise<DecisaoDoGatilhoDeMensagem> {
  try {
    const { rows: eventos } = await pool.query<{ id: string; consumido: boolean; status: string; created_at: string }>(
      `select l.id, $3 = any(coalesce(l.consumed_by, '{}')) as consumido, l.status, l.created_at
         from event_log l
        where l.entity_kind = 'message' and l.entity_id = $2
          and l.organization_id = $1 and l.event_type = 'message.received'
        order by l.created_at desc
        limit 1`,
      [pedido.organizationId, pedido.messageId, AUTOMACAO_GATILHOS_HANDLER_KEY],
    );
    const evento = eventos[0];
    if (!evento) return "seguir";

    if (evento.consumido || evento.status === "done" || evento.status === "dead") {
      const { rows } = await pool.query(
        `select 1 from followup_enrollments e
           join followup_flow_versions v on v.organization_id = e.organization_id and v.id = e.version_id
          where e.organization_id = $1 and e.lane = 'automacao' and e.origin_event_id = $2
            and exists (select 1 from jsonb_array_elements(coalesce(v.graph->'nodes', '[]'::jsonb)) n
                         where n->>'type' in ('message', 'question'))
          limit 1`,
        [pedido.organizationId, evento.id],
      );
      return rows.length > 0 ? "ceder" : "seguir";
    }

    const idade = (pedido.agora ?? new Date()).getTime() - new Date(evento.created_at).getTime();
    if (!(idade < TETO_DA_ESPERA_PELO_GATILHO_MS)) return "seguir";

    const { rows: armadas } = await pool.query(
      `select 1 from followup_flow_pointers p
         join followup_flow_versions v on v.organization_id = p.organization_id and v.id = p.active_version_id
        where p.organization_id = $1 and p.surface = 'automacao' and p.status = 'active'
          and exists (select 1 from jsonb_array_elements(coalesce(v.graph->'nodes', '[]'::jsonb)) n,
                             jsonb_array_elements(coalesce(n->'config'->'triggers', '[]'::jsonb)) g
                       where n->>'type' = 'trigger' and g->>'kind' = 'message_received')
          and exists (select 1 from jsonb_array_elements(coalesce(v.graph->'nodes', '[]'::jsonb)) n
                       where n->>'type' in ('message', 'question'))
        limit 1`,
      [pedido.organizationId],
    );
    return armadas.length > 0 ? "esperar" : "seguir";
  } catch {
    return "seguir";
  }
}
