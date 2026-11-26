"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import type { BudgetStatus } from "@/lib/ai/budget/check";

export type { BudgetStatus };

export interface BudgetPatch {
  monthly_limit_cents?: number;
  alarm_threshold_pct?: number;
  /**
   * A INTENÇÃO, declarada — não inferida da forma do payload. É o campo que
   * decide se o teto vincula alguém; sem ele, "escolhi um teto" e "nunca abri a
   * tela" seriam o mesmo dado.
   */
  enforcement_mode?: "off" | "avisar" | "bloquear";
  /** Renuncia às 72h de carência ao armar a parada. */
  confirmar_imediato?: boolean;
}

interface SingleResponse {
  data: BudgetStatus;
}

/**
 * O teto de gasto de IA é ajustado só pelo administrador da plataforma, no
 * painel de cada empresa (decisão do dono do produto, 25/11/2026). A rota é a
 * do admin, com a organização no PATH; a chave do cache leva a organização
 * para o estado de uma empresa nunca aparecer na tela de outra.
 */
function rotaDoOrcamento(organizationId: string): string {
  return `/api/v1/admin/tenants/${encodeURIComponent(organizationId)}/ai-budget`;
}

export function aiBudgetQueryKey(organizationId: string) {
  return ["admin", "tenants", organizationId, "ai-budget"] as const;
}

export function useAiBudget(organizationId: string, opts?: { initialData?: BudgetStatus }) {
  return useQuery({
    queryKey: aiBudgetQueryKey(organizationId),
    queryFn: async () => {
      try {
        const res = await apiClient.get<SingleResponse>(rotaDoOrcamento(organizationId));
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
    staleTime: 30_000,
  });
}

export function useUpdateBudget(organizationId: string) {
  const qc = useQueryClient();
  const t = useT();
  const queryKey = aiBudgetQueryKey(organizationId);
  return useMutation({
    mutationKey: [...queryKey, "update"],
    mutationFn: async (patch: BudgetPatch) => {
      const res = await apiClient.patch<SingleResponse>(rotaDoOrcamento(organizationId), patch);
      return res.data;
    },
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<BudgetStatus>(queryKey);
      if (previous) {
        const optimistic: BudgetStatus = {
          ...previous,
          ...(patch.monthly_limit_cents !== undefined
            ? { monthly_limit_cents: patch.monthly_limit_cents }
            : {}),
          ...(patch.alarm_threshold_pct !== undefined
            ? { alarm_threshold_pct: patch.alarm_threshold_pct }
            : {}),
          // `confirmar_imediato` NÃO entra: ele não é estado, é a renúncia à
          // carência naquele clique. O `enforcement_effective_at` que ele decide
          // vem do servidor — otimizá-lo aqui seria a tela inventar uma data.
          ...(patch.enforcement_mode !== undefined
            ? { enforcement_mode: patch.enforcement_mode }
            : {}),
        };
        qc.setQueryData(queryKey, optimistic);
      }
      return { previous };
    },
    onError: (err, _patch, context) => {
      if (context?.previous) {
        qc.setQueryData(queryKey, context.previous);
      }
      showApiError(err);
    },
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data);
      toast.success(t("Orçamento atualizado"));
    },
  });
}
