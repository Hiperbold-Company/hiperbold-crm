"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** A chave da contagem — `useRegistrarEvento` a invalida quando alguém registra um evento. */
export function chaveDosEventosManuais(pipelineId: string) {
  return ["eventos-manuais", pipelineId] as const;
}

/**
 * Eventos manuais por negócio do funil, contados no servidor (migration 0979).
 *
 * Só busca com o filtro ATIVO (`ativo`): o quadro sem o filtro não paga a
 * consulta. Devolve `undefined` enquanto não chegou — `applyFilters` então não
 * aplica o filtro de eventos, em vez de tratar todos como zero.
 */
export function useEventosManuais(
  pipelineId: string,
  ativo: boolean,
): ReadonlyMap<string, number> | undefined {
  const { data } = useQuery({
    queryKey: chaveDosEventosManuais(pipelineId),
    enabled: ativo,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await apiClient.get<{ data: { contagens: Record<string, number> } }>(
        `/api/v1/pipelines/${pipelineId}/eventos-manuais`,
      );
      return new Map(Object.entries(res?.data?.contagens ?? {}));
    },
  });
  return ativo ? data : undefined;
}
