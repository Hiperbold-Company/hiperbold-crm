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
import type pg from "pg";

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
