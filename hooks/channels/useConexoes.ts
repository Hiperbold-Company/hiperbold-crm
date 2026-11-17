"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { CartaoDaConexao } from "@/lib/channels/conexoes-em-cartoes";

export type { CartaoDaConexao, StatusDaConexao, TipoDaConexao } from "@/lib/channels/conexoes-em-cartoes";

/**
 * Todas as conexões vivas da organização, uma por cartão (`GET /api/v1/channels/conexoes`).
 *
 * `["conexoes"]` é a chave que quem cria, renomeia ou remove uma conexão invalida para a grade
 * se refazer. A resposta não traz credencial nenhuma (ver `lib/channels/conexoes-em-cartoes.ts`).
 */
export function useConexoes() {
  return useQuery({
    queryKey: ["conexoes"],
    queryFn: async () => (await apiClient.get<{ data: CartaoDaConexao[] }>("/api/v1/channels/conexoes")).data,
    staleTime: 15_000,
  });
}
