/**
 * O AVISO DA TAREFA QUE VENCEU — quem recebe e o que o aviso diz.
 *
 * Duas saídas usam estas regras, e por isso elas moram aqui e não em cada uma:
 *
 *   - o push ao celular (`lib/notifications/push.handler.ts`, evento
 *     `crm_task.due` que o cron `tarefas-vencidas` emite pela migration 0980);
 *   - o sino de tarefas da barra do topo (`components/shell/SinoDeTarefas.tsx`),
 *     que avisa com o CRM aberto e mostra o que venceu.
 *
 * QUEM RECEBE: quem criou a tarefa e o responsável — uma vez cada, mesmo que
 * sejam a mesma pessoa (o caso comum: "eu marco para mim"). Ninguém mais da
 * organização: a tarefa é um combinado de alguém, não um alerta da equipe.
 */
import type { Tarefa } from "./tipos";

/** Quem criou e o responsável, sem repetir e sem vazio. */
export function destinatariosDoAviso(
  tarefa: Pick<Tarefa, "created_by" | "assigned_to">,
): string[] {
  const ids = [tarefa.created_by, tarefa.assigned_to].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return [...new Set(ids)];
}

/**
 * O endereço do negócio no quadro, o mesmo que a Central usa para "Abrir
 * negócio" (`REFERENCIAS_DE_AVISO.lead`). Sem negócio (ou sem funil visível),
 * a tela de Tarefas, onde a tarefa está.
 */
export function destinoDaTarefa(leadId: string | null, pipelineId: string | null): string {
  if (leadId && pipelineId) return `/app/pipelines/${pipelineId}?lead=${leadId}`;
  return "/app/tasks";
}

/**
 * O aviso ainda vale? O evento sai do cron, e o push sai depois, quando o
 * barramento drena. No meio a pessoa pode ter concluído a tarefa ou remarcado o
 * prazo — e avisar "é agora" sobre algo feito ou adiado é ruído. O prazo é
 * comparado em milissegundos porque o banco e o JSON escrevem o mesmo instante
 * de formas diferentes.
 */
export function avisoAindaVale(
  tarefa: Pick<Tarefa, "status" | "due_date">,
  prazoDoEvento: string | null,
): boolean {
  if (tarefa.status !== "pending" && tarefa.status !== "in_progress") return false;
  if (!tarefa.due_date || !prazoDoEvento) return false;
  const atual = new Date(tarefa.due_date).getTime();
  const avisado = new Date(prazoDoEvento).getTime();
  return Number.isFinite(atual) && atual === avisado;
}

/**
 * Quais tarefas do sino ainda não foram avisadas NESTE navegador.
 *
 * A chave é tarefa + prazo, a mesma régua do banco (`due_notified_for`):
 * remarcar rearma o aviso. Só entra o que venceu há até `janelaMs` — quem abre
 * o CRM de manhã não leva vinte avisos de tarefas atrasadas há semanas; essas
 * ficam na lista do sino, que é o lugar delas.
 */
export function chaveDoAviso(tarefa: Pick<Tarefa, "id" | "due_date">): string {
  return `${tarefa.id}@${tarefa.due_date ?? ""}`;
}

export function avisosNovos<T extends Pick<Tarefa, "id" | "due_date">>(
  tarefas: readonly T[],
  jaAvisadas: ReadonlySet<string>,
  agora: Date,
  janelaMs: number,
): T[] {
  return tarefas.filter((tarefa) => {
    if (!tarefa.due_date) return false;
    const prazo = new Date(tarefa.due_date).getTime();
    if (!Number.isFinite(prazo)) return false;
    if (prazo > agora.getTime()) return false;
    if (agora.getTime() - prazo > janelaMs) return false;
    return !jaAvisadas.has(chaveDoAviso(tarefa));
  });
}
