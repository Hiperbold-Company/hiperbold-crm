"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { apiClient } from "@/lib/api/client";
import type {
  ItemDoNegocio,
  ItemDoNegocioCreate,
  ItemDoNegocioPatch,
} from "@/lib/schemas/lead-itens";

/** A chave do cache dos itens de UM negócio. */
export function chaveDosItens(leadId: string | null) {
  return ["lead-itens", leadId] as const;
}

/**
 * Os produtos de um negócio (`GET /api/v1/leads/:id/itens`).
 *
 * `leadId = null` desliga a consulta (diálogo fechado). Devolve a lista já
 * desembrulhada; enquanto carrega, `undefined` — quem usa decide se mostra o
 * valor digitado ou espera, e NUNCA presume "sem itens" antes da resposta.
 */
export function useItensDoNegocio(leadId: string | null) {
  return useQuery({
    queryKey: chaveDosItens(leadId),
    enabled: !!leadId,
    queryFn: async () => {
      const res = await apiClient.get<{ data: ItemDoNegocio[] }>(`/api/v1/leads/${leadId}/itens`);
      return res.data;
    },
  });
}

/**
 * Adicionar, alterar e remover produtos do negócio.
 *
 * Depois de qualquer escrita o quadro é invalidado: o valor do negócio é a soma
 * dos itens (gatilho do banco) e o card, o total da coluna e o cabeçalho do
 * dossiê leem o `value_cents` dele.
 */
export function useMutacoesDosItens(leadId: string, pipelineId: string) {
  const qc = useQueryClient();
  const depois = () => {
    void qc.invalidateQueries({ queryKey: chaveDosItens(leadId) });
    void qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
  };

  const adicionar = useMutation({
    mutationFn: (corpo: ItemDoNegocioCreate) =>
      apiClient.post<{ data: { item: ItemDoNegocio; lead_value_cents: number | null } }>(
        `/api/v1/leads/${leadId}/itens`,
        corpo,
      ),
    onError: showApiError,
    onSettled: depois,
  });

  const alterar = useMutation({
    mutationFn: ({ itemId, patch }: { itemId: string; patch: ItemDoNegocioPatch }) =>
      apiClient.patch<{ data: { item: ItemDoNegocio; lead_value_cents: number | null } }>(
        `/api/v1/leads/${leadId}/itens/${itemId}`,
        patch,
      ),
    onError: showApiError,
    onSettled: depois,
  });

  const remover = useMutation({
    mutationFn: (itemId: string) =>
      apiClient.delete<{ data: { id: string; lead_value_cents: number | null } }>(
        `/api/v1/leads/${leadId}/itens/${itemId}`,
      ),
    onError: showApiError,
    onSettled: depois,
  });

  return { adicionar, alterar, remover };
}
