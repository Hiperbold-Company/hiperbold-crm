"use client";

import { useQuery } from "@tanstack/react-query";

import type { TarefaComNegocio } from "@/lib/tarefas/tipos";

/**
 * As tarefas abertas cujo prazo já chegou, de quem está olhando (criou ou é
 * responsável) — o que o sino de tarefas mostra.
 *
 * Aqui a releitura periódica é o mecanismo, não desperdício (o `useTasks` a
 * tirou pelo motivo contrário): o que muda a lista é o RELÓGIO, não um clique
 * desta aba. Um minuto é a mesma cadência do cron que manda o push, e a
 * consulta é um recorte pequeno (as minhas, abertas, vencidas).
 *
 * A chave começa por `crm_tasks`, a mesma das mutações de `useTasks`: concluir
 * uma tarefa no painel do negócio tira ela do sino na mesma hora.
 */
export const CHAVE_DAS_VENCIDAS = ["crm_tasks", "vencidas-para-mim"] as const;

export function useTarefasVencidasParaMim(habilitado: boolean) {
  return useQuery({
    queryKey: CHAVE_DAS_VENCIDAS,
    enabled: habilitado,
    queryFn: async (): Promise<TarefaComNegocio[]> => {
      const res = await fetch("/api/v1/tasks?para_mim=true&vencidas=true&com_negocio=true");
      if (!res.ok) throw new Error("Não foi possível carregar as tarefas.");
      const json = (await res.json()) as { data: { tasks: TarefaComNegocio[] } };
      return json.data.tasks;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}
