"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { RelatorioDePerdas } from "@/lib/metrics/perdas";

export interface PerdasPayload extends RelatorioDePerdas {
  janela: { from: string; to: string };
  /** A leitura bateu no teto: o relatório está cortado, não completo. */
  truncado: boolean;
}

/**
 * Relatório "Perdas" (issue #1537) — manager+. Sem `janela`, os últimos 30 dias;
 * a tela Desempenho passa o período do filtro global.
 */
export function usePerdasMetrics(enabled = true, janela?: { from: string; to: string }) {
  const qs = janela ? `?${new URLSearchParams({ from: janela.from, to: janela.to }).toString()}` : "";
  return useQuery({
    queryKey: ["metrics", "perdas", janela?.from ?? "", janela?.to ?? ""],
    queryFn: async () => apiClient.get<{ data: PerdasPayload }>(`/api/v1/metrics/lost${qs}`),
    staleTime: 30_000,
    enabled,
  });
}
