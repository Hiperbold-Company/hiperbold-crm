"use client";
import { useQuery } from "@tanstack/react-query";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { ReguaDaExclusao } from "@/lib/tenants/regua-de-cobranca";

/**
 * Hiperbold: a régua de cobrança libera a exclusão manual desta organização? Lê
 * `GET /api/v1/admin/tenants/[id]/exclusao`. A tela usa só para desabilitar o botão com o motivo; quem decide
 * de verdade é o servidor, que confere de novo ao excluir e ao programar.
 *
 * `motivo` é `null` só quando a exclusão está liberada. Carregando ou com erro, o botão fica desabilitado
 * (exclusão é irreversível: na dúvida, não oferece). O motivo sai pelo CÓDIGO, com chave literal no `t()`:
 * a frase do servidor não passa por `t()` (seria chave construída em runtime).
 */
export function useReguaDaExclusao(organizationId: string, enabled: boolean) {
  const t = useT();
  const consulta = useQuery({
    queryKey: ["admin", "tenant", organizationId, "regua-da-exclusao"] as const,
    queryFn: () => apiClient.get<{ data: ReguaDaExclusao }>(`/api/v1/admin/tenants/${organizationId}/exclusao`),
    enabled: enabled && !!organizationId,
    staleTime: 30_000,
  });

  const ilegivel = t("Não foi possível conferir a cobrança desta empresa agora. Tente de novo.");
  let motivo: string | null;
  if (consulta.isPending) motivo = t("Conferindo a cobrança desta empresa…");
  else if (consulta.isError) motivo = ilegivel;
  else {
    const regua = consulta.data.data;
    if (regua.liberada) motivo = null;
    else if (regua.codigo === "exclusao_na_regua_de_cobranca") {
      motivo = t("Esta empresa está na régua de cobrança; a exclusão só é liberada quando a régua termina.");
    } else motivo = ilegivel;
  }

  return { motivo };
}
