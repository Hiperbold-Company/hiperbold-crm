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
 * Exceção, o DIRECT: a execução que começou por um comentário fala primeiro
 * pela resposta privada, que não vira linha de `messages` (contrato do canal,
 * seção 4), e a conversa só nasce quando a pessoa responde. Por isso (b) vale
 * também quando a conversa é a do Direct de quem comentou — mesma conexão
 * (`vars.gatilho.channel_session_id`) e mesmo IGSID
 * (`provider_conversation_id` = `vars.gatilho.autor_id`), ver
 * `conversa-do-direct.ts`. Outra conta do Instagram ou outra pessoa não cala a IA.
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

import { instanteDoBanco } from "@/lib/tempo/agora";
import {
  AUTOMACAO_GATILHOS_HANDLER_KEY,
  EVENTO_DA_EXECUCAO_RESPOSTA_FALHOU,
  EVENTO_DA_EXECUCAO_RESPOSTA_SAIU,
} from "./chaves";
import { inboundContaComoResposta } from "./conversa";
import { casaGatilho, type FatoDeMensagem } from "./gatilhos";
import { automacaoTriggerSchema, type AutomacaoTrigger } from "./schemas";

/** Instante de coluna do banco em ms: string (PostgREST) ou `Date` (driver `pg`); NaN se inválido. */
function msDoBanco(valor: unknown): number {
  return Date.parse(instanteDoBanco(valor) ?? "");
}

/** Mensagem com mais tempo que isto (desde que chegou) não inicia automação (`gatilhos.handler.ts`). */
export const IDADE_MAXIMA_DA_MENSAGEM_MS = 10 * 60_000;

/** Os gatilhos "mensagem recebida" legíveis de um `config.triggers` cru do grafo. */
function gatilhosDeMensagem(cru: unknown): Array<Extract<AutomacaoTrigger, { kind: "message_received" }>> {
  if (!Array.isArray(cru)) return [];
  return cru.flatMap((g) => {
    const r = automacaoTriggerSchema.safeParse(g);
    return r.success && r.data.kind === "message_received" ? [r.data] : [];
  });
}

export async function automacaoEsperaRespostaNaConversa(
  pool: Pick<pg.Pool, "query">,
  pedido: { organizationId: string; conversationId: string },
): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `select 1 from followup_enrollments e
        where e.organization_id = $1
          and e.lane = 'automacao' and e.status = 'waiting_reply'
          and (
            exists (
              select 1 from messages m
               where m.organization_id = $1
                 and m.conversation_id = $2
                 and m.direction = 'outbound'
                 and m.metadata->'origem_automacao'->>'enrollment_id' = e.id::text
            )
            or exists (
              select 1 from conversations c
               where c.organization_id = $1
                 and c.id = $2
                 and e.vars->'gatilho'->>'tipo' = 'instagram_comment'
                 and c.channel_session_id::text = e.vars->'gatilho'->>'channel_session_id'
                 and c.provider_conversation_id = e.vars->'gatilho'->>'autor_id'
            )
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
 * Eventos de uma execução que NÃO tiram o bloco de conversa da espera: o
 * despertar pela resposta (`inbound_woke`, gravado pela reatividade) e os
 * efeitos de dentro do bloco (nova tentativa, registrar resposta). Qualquer
 * outro evento depois de `wait_started` é a saída da espera (avançou, terminou,
 * morreu, foi cancelada).
 */
const EVENTOS_DENTRO_DA_ESPERA = new Set([
  "inbound_woke",
  "effect_started",
  "effect_pending",
  "effect_done",
  "effect_failed",
  "action_recheck",
  // O desfecho da resposta do Instagram (`desfecho-da-resposta.handler.ts`) é
  // gravado no nó ATUAL, muitas vezes depois do `wait_started`: só história.
  EVENTO_DA_EXECUCAO_RESPOSTA_SAIU,
  EVENTO_DA_EXECUCAO_RESPOSTA_FALHOU,
]);

/**
 * Pura: a execução estava esperando resposta (bloco de conversa) no instante
 * `t`? Lê os eventos dela até `t`, do mais novo para o mais velho: o primeiro
 * evento de saída antes de achar um `wait_started` (`wake_status =
 * waiting_reply`) diz que não estava.
 */
export function esperavaRespostaEm(
  eventos: ReadonlyArray<{ event_type: string; payload: Record<string, unknown> | null; created_at: string }>,
  t: string,
): boolean {
  const limite = Date.parse(t);
  if (!Number.isFinite(limite)) return false;
  const ate = eventos
    .filter((e) => msDoBanco(e.created_at) <= limite)
    .sort((a, b) => msDoBanco(b.created_at) - msDoBanco(a.created_at));
  for (const e of ate) {
    if (e.event_type === "wait_started") return e.payload?.wake_status === "waiting_reply";
    if (!EVENTOS_DENTRO_DA_ESPERA.has(e.event_type)) return false;
  }
  return false;
}

/**
 * A mesma pergunta pelo PostgREST, para o handler dos gatilhos (que roda no
 * dreno do `event_log`, sem `pg`): a mensagem é RESPOSTA a uma automação nesta
 * conversa? Então ela é daquela automação, e não "mensagem recebida" para
 * iniciar outras.
 *
 * Decide pela MENSAGEM, não só pelo status do instante. A ordem dos
 * consumidores do mesmo `message.received` (`register-handlers.ts`):
 *  1. `followup-reactivity.v1` acorda a espera (`inbound_woke`, `next_eval_at =
 *     agora`; o status segue `waiting_reply`);
 *  2. ... `automacao-gatilhos.v1` (este) roda DEPOIS, no mesmo dreno;
 *  3. o motor (`followup-flow-worker`, 1×/min) lê a resposta, registra e
 *     avança — a execução sai de `waiting_reply`.
 * Num dreno normal (2) vê ainda `waiting_reply`. Mas o evento pode voltar à
 * fila (erro, worker reiniciado) e ser lido DEPOIS de (3): o status já não diz
 * nada. Por isso conta como resposta quando qualquer execução de automação que
 * falou nesta conversa ANTES da mensagem:
 *  - está em `waiting_reply` agora; ou
 *  - estava esperando resposta quando a mensagem chegou (`esperavaRespostaEm`
 *    no `created_at` dela: `wait_started` antes, a saída da espera depois) —
 *    é ela que consumiu a mensagem como resposta.
 * Mais as execuções que começaram por comentário e cuja conversa do Direct é
 * esta (`execucoesDoDirectNaConversa`): o "quero" que a pessoa manda depois da
 * resposta privada é delas, mesmo sem envio anterior nesta conversa (que nem
 * existia quando a espera começou).
 *
 * Diferente da versão do drain, aqui erro LANÇA: o handler devolve `error` e o
 * evento volta para a fila. Falhar aberto iniciaria automação em cima de uma
 * resposta — duas vozes de automação, que é o que a regra existe para evitar.
 */
export async function automacaoEsperaRespostaNaConversaSupabase(
  admin: SupabaseClient,
  pedido: { organizationId: string; conversationId: string; chegadaEm?: string | null },
): Promise<boolean> {
  let saidas = admin
    .from("messages")
    .select("metadata")
    .eq("organization_id", pedido.organizationId)
    .eq("conversation_id", pedido.conversationId)
    .eq("direction", "outbound")
    .not("metadata->origem_automacao", "is", null);
  if (pedido.chegadaEm) saidas = saidas.lte("created_at", pedido.chegadaEm);
  const { data: enviadas, error } = await saidas.order("created_at", { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  const ids = [
    ...new Set(
      ((enviadas ?? []) as Array<{ metadata: unknown }>).flatMap((m) => {
        const origem = (m.metadata as { origem_automacao?: { enrollment_id?: unknown } } | null)?.origem_automacao;
        return typeof origem?.enrollment_id === "string" ? [origem.enrollment_id] : [];
      }),
    ),
  ];
  const doDirect = await execucoesDoDirectNaConversa(admin, pedido);
  if (ids.length === 0 && doDirect.length === 0) return false;
  let lista: Array<{ id: string; status: string }> = [];
  if (ids.length > 0) {
    const { data: execucoes, error: e2 } = await admin
      .from("followup_enrollments")
      .select("id, status")
      .eq("organization_id", pedido.organizationId)
      .eq("lane", "automacao")
      .in("id", ids);
    if (e2) throw new Error(e2.message);
    lista = (execucoes ?? []) as Array<{ id: string; status: string }>;
  }
  if (lista.some((e) => e.status === "waiting_reply")) return true;
  // Direct: a execução que nasceu DEPOIS da mensagem não a tem como resposta.
  if (
    doDirect.some(
      (e) => e.status === "waiting_reply" && (!pedido.chegadaEm || msDoBanco(e.created_at) <= Date.parse(pedido.chegadaEm)),
    )
  ) {
    return true;
  }
  for (const e of doDirect) if (!lista.some((l) => l.id === e.id)) lista.push(e);
  if (!pedido.chegadaEm || lista.length === 0) return false;

  const { data: eventos, error: e3 } = await admin
    .from("followup_enrollment_events")
    .select("enrollment_id, event_type, payload, created_at")
    .eq("organization_id", pedido.organizationId)
    .in(
      "enrollment_id",
      lista.map((e) => e.id),
    )
    .lte("created_at", pedido.chegadaEm)
    .order("created_at", { ascending: false })
    .limit(500);
  if (e3) throw new Error(e3.message);
  const porExecucao = new Map<string, Array<{ event_type: string; payload: Record<string, unknown> | null; created_at: string }>>();
  for (const ev of (eventos ?? []) as Array<{
    enrollment_id: string;
    event_type: string;
    payload: Record<string, unknown> | null;
    created_at: string;
  }>) {
    const l = porExecucao.get(ev.enrollment_id) ?? [];
    l.push(ev);
    porExecucao.set(ev.enrollment_id, l);
  }
  return [...porExecucao.values()].some((l) => esperavaRespostaEm(l, pedido.chegadaEm!));
}

/**
 * As execuções de automação que começaram por um comentário cuja conversa do
 * Direct é ESTA (mesma conexão, mesmo IGSID — `conversa-do-direct.ts`). Elas
 * não têm envio nesta conversa antes da resposta: a resposta privada não vira
 * linha de `messages`. Lança em falha do banco, como a função que a chama.
 */
async function execucoesDoDirectNaConversa(
  admin: SupabaseClient,
  pedido: { organizationId: string; conversationId: string },
): Promise<Array<{ id: string; status: string; created_at: string }>> {
  const { data: conversa, error } = await admin
    .from("conversations")
    .select("channel_session_id, provider_conversation_id")
    .eq("organization_id", pedido.organizationId)
    .eq("id", pedido.conversationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const c = conversa as { channel_session_id: string | null; provider_conversation_id: string | null } | null;
  if (!c?.channel_session_id || !c.provider_conversation_id) return [];
  const { data, error: e2 } = await admin
    .from("followup_enrollments")
    .select("id, status, created_at")
    .eq("organization_id", pedido.organizationId)
    .eq("lane", "automacao")
    .eq("vars->gatilho->>tipo", "instagram_comment")
    .eq("vars->gatilho->>channel_session_id", c.channel_session_id)
    .eq("vars->gatilho->>autor_id", c.provider_conversation_id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (e2) throw new Error(e2.message);
  return (data ?? []) as Array<{ id: string; status: string; created_at: string }>;
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
 *     conversa E que ainda está viva (`active`/`waiting_reply`) ou já falou
 *     (mensagem de saída com `metadata.origem_automacao.enrollment_id` dela);
 *     senão segue (o gatilho não casou, a automação foi recusada por
 *     reentrada, espera, teto, ou terminou por um caminho sem conversa — e
 *     então ninguém falou). Se a execução viva terminar SEM falar depois de a
 *     IA ter cedido, o motor devolve o turno (`devolverTurnoDoInicio`);
 *  2. ainda não consumiu, mas há automação ATIVA com gatilho "mensagem
 *     recebida" e bloco de conversa cujo gatilho PODE casar esta mensagem
 *     (palavra-chave, canal, "só a primeira" avaliados; mensagem com menos de
 *     `IDADE_MAXIMA_DA_MENSAGEM_MS`) → `esperar` (o drain adia o turno alguns
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
            and (e.status in ('active', 'waiting_reply')
                 or exists (select 1 from messages m
                             where m.organization_id = $1 and m.direction = 'outbound'
                               and m.metadata->'origem_automacao'->>'enrollment_id' = e.id::text))
          limit 1`,
        [pedido.organizationId, evento.id],
      );
      return rows.length > 0 ? "ceder" : "seguir";
    }

    const agora = pedido.agora ?? new Date();
    const idade = agora.getTime() - new Date(evento.created_at).getTime();
    if (!(idade < TETO_DA_ESPERA_PELO_GATILHO_MS)) return "seguir";

    const { rows: armadas } = await pool.query<{ triggers: unknown }>(
      `select n->'config'->'triggers' as triggers
         from followup_flow_pointers p
         join followup_flow_versions v on v.organization_id = p.organization_id and v.id = p.active_version_id
         cross join lateral jsonb_array_elements(coalesce(v.graph->'nodes', '[]'::jsonb)) n
        where p.organization_id = $1 and p.surface = 'automacao' and p.status = 'active'
          and n->>'type' = 'trigger'
          and exists (select 1 from jsonb_array_elements(coalesce(n->'config'->'triggers', '[]'::jsonb)) g
                       where g->>'kind' = 'message_received')
          and exists (select 1 from jsonb_array_elements(coalesce(v.graph->'nodes', '[]'::jsonb)) c
                       where c->>'type' in ('message', 'question'))`,
      [pedido.organizationId],
    );
    const gatilhos = armadas.flatMap((r) => gatilhosDeMensagem(r.triggers));
    if (gatilhos.length === 0) return "seguir";

    // Esperar só vale se algum gatilho armado PODE casar ESTA mensagem: a
    // palavra-chave, o canal e "só a primeira" avaliados como o handler avalia.
    const { rows: msgs } = await pool.query<{
      body: string | null;
      type: string | null;
      channel_session_id: string | null;
      conversation_id: string;
      created_at: string;
    }>(
      `select body, type, channel_session_id, conversation_id, created_at
         from messages
        where organization_id = $1 and id = $2 and direction = 'inbound'`,
      [pedido.organizationId, pedido.messageId],
    );
    const m = msgs[0];
    if (!m) return "seguir";
    // Mensagem velha: o handler não a usa para iniciar (`IDADE_MAXIMA_DA_MENSAGEM_MS`).
    if (agora.getTime() - new Date(m.created_at).getTime() > IDADE_MAXIMA_DA_MENSAGEM_MS) return "seguir";
    const corpo = (m.body ?? "").slice(0, 280);
    if (!inboundContaComoResposta({ type: m.type, body: corpo })) return "seguir";
    let primeira: boolean | undefined;
    if (gatilhos.some((g) => g.only_first_message)) {
      const { rows: antes } = await pool.query(
        `select 1 from messages
          where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
            and id <> $3 and created_at < $4
          limit 1`,
        [pedido.organizationId, m.conversation_id, pedido.messageId, m.created_at],
      );
      primeira = antes.length === 0;
    }
    const fato: FatoDeMensagem = {
      tipo: "message_received",
      message_id: pedido.messageId,
      conversation_id: m.conversation_id,
      contact_id: "",
      channel_session_id: m.channel_session_id,
      texto: corpo,
      causado_pela_automacao: null,
      ...(primeira !== undefined ? { primeira_da_conversa: primeira } : {}),
    };
    return gatilhos.some((g) => casaGatilho(g, fato, false)) ? "esperar" : "seguir";
  } catch {
    return "seguir";
  }
}
