"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/**
 * "Marcar como não lida" (gesto do atendente, o espelho de `useMarkAsRead`).
 * O contador sobe para pelo menos 1; nada vai ao canal. Invalida as mesmas
 * famílias de cache da leitura, para o selo azul da lista e o número do topo
 * acompanharem sem recarregar.
 */
export function useMarkAsUnread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ data: unknown }>(`/api/v1/conversations/${id}/mark-unread`, {}),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", id] });
      qc.invalidateQueries({ queryKey: ["conversation-counts"] });
    },
  });
}
