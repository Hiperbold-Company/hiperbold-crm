"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { EstadoDoEnsino } from "@/lib/ai/rag/conversa-que-ensina";

export function chaveDoEnsino(conversationId: string) {
  return ["conversation", conversationId, "ensinar-agente"] as const;
}

/**
 * "Usar para ensinar o agente": lê e troca a marcação da conversa
 * (`/api/v1/conversations/[id]/usable-for-rag`). O estado exibido é sempre o
 * que o servidor devolveu — nada de marcar na tela antes da resposta.
 */
export function useEnsinarAgente(conversationId: string, habilitado: boolean) {
  const qc = useQueryClient();
  const t = useT();
  const chave = chaveDoEnsino(conversationId);

  const estado = useQuery({
    queryKey: chave,
    enabled: habilitado,
    queryFn: async () =>
      (
        await apiClient.get<{ data: EstadoDoEnsino }>(
          `/api/v1/conversations/${conversationId}/usable-for-rag`,
        )
      ).data,
  });

  const alternar = useMutation({
    mutationFn: async (enabled: boolean) =>
      (
        await apiClient.post<{ data: EstadoDoEnsino }>(
          `/api/v1/conversations/${conversationId}/usable-for-rag`,
          { enabled },
        )
      ).data,
    onSuccess: (novo) => {
      qc.setQueryData(chave, novo);
      toast.success(
        novo.usable_for_rag
          ? t("Conversa marcada. Ela entra no conhecimento do agente na próxima rodada noturna.")
          : t("Marcação retirada."),
      );
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: chave });
      showApiError(err);
    },
  });

  return { estado, alternar };
}
