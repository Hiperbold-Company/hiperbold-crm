"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { COLUNAS_PADRAO } from "@/lib/contacts/colunas-da-lista";

interface Escolha {
  colunas: string[];
  padrao: boolean;
}

const CHAVE = ["contacts-colunas"] as const;

/** As colunas que o usuário escolheu (salvas no servidor). Enquanto carrega, as de sempre. */
export function useColunasDeContatos() {
  const qc = useQueryClient();
  const consulta = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: Escolha }>("/api/v1/contacts/colunas")).data,
    staleTime: 5 * 60_000,
  });
  const aoSalvar = (d: { data: Escolha }) => qc.setQueryData(CHAVE, d.data);
  const salvar = useMutation({
    mutationFn: (colunas: string[]) => apiClient.put<{ data: Escolha }>("/api/v1/contacts/colunas", { colunas }),
    onSuccess: aoSalvar,
  });
  const restaurar = useMutation({
    mutationFn: () => apiClient.delete<{ data: Escolha }>("/api/v1/contacts/colunas"),
    onSuccess: aoSalvar,
  });
  return {
    colunas: consulta.data?.colunas ?? [...COLUNAS_PADRAO],
    padrao: consulta.data?.padrao ?? true,
    carregando: consulta.isLoading,
    salvar,
    restaurar,
  };
}
