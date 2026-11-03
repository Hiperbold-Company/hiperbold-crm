/**
 * UMA VOZ SÓ enquanto uma automação espera a resposta do contato.
 *
 * Uma execução de automação em `waiting_reply` está num bloco de conversa
 * (mensagem com opções, pergunta, espera "até responder") — é o único jeito de
 * a raia `automacao` chegar a esse status. Enquanto ela espera, o agente de IA
 * não responde àquele contato: a mensagem dele é a resposta da automação, e a
 * IA falando por cima mandaria duas respostas à mesma escolha. Quando a
 * execução sai da espera (respondeu, tempo esgotado, erro), o status muda e a
 * IA volta ao normal sem nada a desfazer.
 *
 * Fail-open, como `deveCederTurnoAoRetorno`: consulta que falha não cala o
 * agente — o contato sem ninguém é pior que duas vozes pontuais.
 */
import type pg from "pg";

export async function automacaoEsperaRespostaDoContato(
  pool: Pick<pg.Pool, "query">,
  pedido: { organizationId: string; contactId: string },
): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `select 1 from followup_enrollments
        where organization_id = $1 and contact_id = $2
          and lane = 'automacao' and status = 'waiting_reply'
        limit 1`,
      [pedido.organizationId, pedido.contactId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}
