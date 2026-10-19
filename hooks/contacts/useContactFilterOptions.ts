"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface OpcoesDeFiltroDeContatos {
  funis: Array<{ id: string; name: string; etapas: Array<{ id: string; name: string }> }>;
  campos: {
    contato: Array<{ key: string; label: string }>;
    negocio: Array<{ key: string; label: string }>;
  };
}

/** Funis, etapas e campos personalizados que os filtros avançados oferecem. */
export function useContactFilterOptions() {
  return useQuery({
    queryKey: ["contacts-filter-options"],
    queryFn: async () => {
      const r = await apiClient.get<{ data: OpcoesDeFiltroDeContatos }>("/api/v1/contacts/filter-options");
      return r.data;
    },
    staleTime: 60_000,
  });
}
