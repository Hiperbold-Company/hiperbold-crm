"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

/** O que se exclui: a seleção da tela (ids) OU "todos do filtro" (o servidor resolve; `esperado` é o N que a pessoa viu). */
export type AlvoDaExclusao =
  | { ids: string[] }
  | { filtro: Record<string, string>; esperado: number };

export interface ResultadoDaExclusao {
  excluidos: number;
  bloqueados: number;
  /** Anonimizados e lápides de fusão: o lote só opera contato vivo. */
  ignorados: number;
  inexistentes: number;
}

export function useBulkDeleteContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (alvo: AlvoDaExclusao) => {
      const r = await apiClient.post<{ data: ResultadoDaExclusao }>("/api/v1/contacts/bulk-delete", alvo, {
        // Até 5.000 contatos, com mensagens e conversas: bem acima dos 30 s de uma escrita comum.
        timeoutMs: 180_000,
      });
      return r.data;
    },
    onError: showApiError,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
