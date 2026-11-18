"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useDuplicateFollowupFlow } from "@/hooks/followup/useFollowupFlows";
import { useT } from "@/hooks/i18n/useT";
import { Copy } from "@/lib/ui/icons";

/**
 * Duplica a automação (ou o follow-up) do cartão: `POST /api/v1/ai/followup-flows/:id/duplicate`,
 * a mesma regra da tela de follow-ups e das tools MCP. A cópia se chama
 * "<nome> (cópia)" e nasce RASCUNHO: não dispara até alguém revisar e publicar.
 *
 * Automação entra na lista pelo cache da superfície; follow-up chega por props do
 * servidor, por isso o `router.refresh()`.
 */
export function DuplicarAutomacaoButton({
  flowId,
  tipo,
  bloqueado = false,
}: {
  flowId: string;
  tipo: "automacao" | "followup";
  /** Teto do plano cheio: a cópia seria recusada pelo servidor. */
  bloqueado?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const duplicar = useDuplicateFollowupFlow(
    tipo === "automacao"
      ? { surface: "automacao", mensagem: t("Automação duplicada. A cópia está desligada.") }
      : { mensagem: t("Follow-up duplicado. A cópia está desligada.") },
  );

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={duplicar.isPending || bloqueado}
      data-testid="duplicar-automacao"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        duplicar.mutate(flowId, { onSuccess: () => router.refresh() });
      }}
    >
      <Copy size={14} aria-hidden className="mr-1" />
      {duplicar.isPending ? t("Duplicando…") : t("Duplicar")}
    </Button>
  );
}
