"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { filtrosToParams, type FiltrosDaTela } from "@/lib/contacts/filtros-url";

/**
 * Quantos contatos o filtro alcança — o N do "Selecionar todos os N contatos do
 * filtro" e do rodapé da lista. Vem do servidor, pela mesma régua da lista, e a chave
 * começa com `contacts` para que toda mutação de contato (`invalidateQueries(["contacts"])`)
 * a refaça junto.
 */
export function useContactCount(filtros: FiltrosDaTela) {
  return useQuery({
    queryKey: ["contacts", "count", filtros],
    queryFn: async () => {
      const r = await apiClient.get<{ data: { total: number } }>(
        `/api/v1/contacts/count?${filtrosToParams(filtros).toString()}`,
      );
      return r.data.total;
    },
    staleTime: 15_000,
  });
}
