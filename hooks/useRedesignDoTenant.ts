"use client";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export interface RedesignDoTenantPayload {
  id: string;
  ligado: boolean;
}

/** Liga/desliga o novo visual de UMA empresa (`POST /admin/tenants/[id]/redesign`). */
export function useRedesignDoTenant(aoConcluir?: (ligado: boolean) => void) {
  const t = useT();

  return useMutation({
    mutationFn: ({ id, ligado }: RedesignDoTenantPayload) =>
      apiClient.post<{ data: { ligado: boolean } }>(`/api/v1/admin/tenants/${id}/redesign`, {
        ligado,
      }),
    onSuccess: (_resposta, variables) => {
      toast.success(
        variables.ligado
          ? t("Novo visual ligado para esta empresa.")
          : t("Novo visual desligado para esta empresa."),
      );
      aoConcluir?.(variables.ligado);
    },
    onError: (err: Error) => {
      toast.error(t("Erro ao alterar o novo visual"), { description: err.message });
    },
  });
}
