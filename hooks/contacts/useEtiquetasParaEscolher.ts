"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { OpcaoDeEtiqueta } from "@/lib/tags/etiquetas-para-escolher";

/**
 * As etiquetas do vocabulário da organização (cadastradas + em uso), com cor e
 * grupo, para o editor de tags do CONTATO. Fonte: `GET /api/v1/tags/para-escolher`
 * (a mesma da tela Configurações › Tags). Não substitui `useContactTagVocabulary`,
 * que segue alimentando o filtro do Inbox.
 *
 * `staleTime` curto de propósito: o editor é aberto de vez em quando e uma etiqueta
 * recém-criada por outro atendente deve aparecer logo; sem `invalidate` por clique,
 * porque a função de banco varre contatos, leads e conversas.
 */
export function useEtiquetasParaEscolher(orgId: string | null) {
  return useQuery({
    queryKey: ["etiquetas-para-escolher", orgId],
    enabled: !!orgId,
    staleTime: 30_000,
    queryFn: async (): Promise<OpcaoDeEtiqueta[]> => {
      const res = await apiClient.get<{ data: OpcaoDeEtiqueta[] }>("/api/v1/tags/para-escolher");
      return res.data;
    },
  });
}
