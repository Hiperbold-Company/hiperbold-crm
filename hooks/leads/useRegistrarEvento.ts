"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { chaveDaTimeline } from "@/hooks/leads/useLeadTimeline";
import type { EventoManualInput } from "@/lib/leads/evento-manual";

/**
 * "Registrar evento" na ficha: POST /api/v1/leads/[id]/activities.
 *
 * Invalida a timeline do dossiê (`chaveDaTimeline`, a mesma de `useLeadTimeline`)
 * no sucesso e ESPERA o refetch terminar — quem chama pode então pedir à lista
 * que revele o evento (retroativo, ele pode estar além da primeira página). O canal realtime também avisaria, mas quem
 * acabou de registrar precisa ver a própria linha sem depender de a assinatura
 * estar de pé — a mesma razão pela qual a timeline NÃO suprime o eco local.
 */
export function useRegistrarEvento(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EventoManualInput) =>
      apiClient.post<{ data: { id: string } }>(`/api/v1/leads/${leadId}/activities`, input),
    onError: showApiError,
    onSuccess: async () => {
      // A contagem do filtro "Eventos manuais" do quadro (0979) mudou também.
      void qc.invalidateQueries({ queryKey: ["eventos-manuais"] });
      await qc.invalidateQueries({ queryKey: chaveDaTimeline(leadId) });
    },
  });
}
