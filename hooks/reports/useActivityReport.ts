"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { RelatorioDeAtividades } from "@/lib/reports/atividades";

export interface RelatorioComJanela extends RelatorioDeAtividades {
  window: { from: string; to: string };
}

/**
 * O fuso vai no pedido porque a série diária é agrupada NO BANCO. Sem ele o
 * corte do dia seria UTC, e a atividade das 21h de Brasília apareceria no dia
 * seguinte — o relatório afirmaria trabalho num dia sem trabalho.
 */
function fusoDoNavegador(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** `atendente` ausente = "Todos". O filtro é aplicado no servidor. */
export function useActivityReport(dias: number, atendente?: string | null) {
  const tz = fusoDoNavegador();
  return useQuery({
    queryKey: ["reports", "activities", dias, tz, atendente ?? null],
    queryFn: async () =>
      apiClient.get<{ data: RelatorioComJanela }>(
        `/api/v1/reports/activities?days=${dias}&tz=${encodeURIComponent(tz)}` +
          (atendente ? `&atendente=${encodeURIComponent(atendente)}` : ""),
      ),
    staleTime: 30_000,
  });
}
