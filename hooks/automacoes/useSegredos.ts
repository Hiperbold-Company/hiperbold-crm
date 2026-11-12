"use client";

/**
 * As chaves secretas das automações (`/api/v1/automacoes/segredos`). O valor
 * só vai para o servidor; a lista volta com nome e os 4 últimos caracteres.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface SegredoDaTela {
  id: string;
  nome: string;
  ultimos4: string;
  /** Para onde a chave pode ir. `null` = chave antiga: vai para qualquer endereço (a tela avisa). */
  hosts_permitidos: string[] | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export const segredosQueryKey = ["automacoes", "segredos"] as const;

export function useSegredos(enabled = true) {
  return useQuery({
    queryKey: segredosQueryKey,
    queryFn: async () =>
      (await apiClient.get<{ data: SegredoDaTela[] }>("/api/v1/automacoes/segredos")).data,
    enabled,
  });
}

export function useCriarSegredo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { nome: string; valor: string; hosts_permitidos: string[] }) =>
      (await apiClient.post<{ data: SegredoDaTela }>("/api/v1/automacoes/segredos", input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: segredosQueryKey }),
  });
}

export function useTrocarSegredo() {
  const qc = useQueryClient();
  return useMutation({
    // Valor, endereços permitidos, ou os dois. Incluir endereço novo pede o valor junto (a rota recusa sem).
    mutationFn: async ({
      id,
      ...corpo
    }: {
      id: string;
      valor?: string;
      hosts_permitidos?: string[];
    }) =>
      (await apiClient.patch<{ data: SegredoDaTela }>(`/api/v1/automacoes/segredos/${id}`, corpo))
        .data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: segredosQueryKey }),
  });
}

export function useApagarSegredo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiClient.delete<unknown>(`/api/v1/automacoes/segredos/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: segredosQueryKey }),
  });
}
