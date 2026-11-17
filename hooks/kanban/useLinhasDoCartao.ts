"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { apiClient } from "@/lib/api/client";
import type { CampoDoCartao } from "@/lib/kanban/linhas-do-cartao";

/**
 * Grava as linhas do cartão do funil ("Editar cartão"). `null` = voltar ao
 * padrão (a rota apaga a chave). Relê o quadro ao fim: o cartão lê as linhas
 * do `settings` que o quadro traz.
 */
export function useSalvarLinhasDoCartao(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linhas: CampoDoCartao[] | null) =>
      apiClient.patch<{ data: { card_lines: CampoDoCartao[]; padrao: boolean } }>(
        `/api/v1/pipelines/${pipelineId}/card-lines`,
        { card_lines: linhas },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) }),
  });
}
