import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import { useMarcaDasAutomacoes } from "@/lib/redesign/automacoes";
import type { FollowupFlowStatus } from "@/hooks/followup/useFollowupFlows";

const LABEL: Record<FollowupFlowStatus, string> = {
  draft: "Rascunho",
  active: "Ativo",
  disabled: "Desativado",
};

const VARIANT: Record<FollowupFlowStatus, "neutral" | "success" | "warning"> = {
  draft: "neutral",
  active: "success",
  disabled: "warning",
};

export function FlowStatusBadge({ status }: { status: FollowupFlowStatus }) {
  const t = useT();
  const rd = useMarcaDasAutomacoes();
  return (
    <Badge variant={VARIANT[status]} data-rd-automacoes={rd("estado")} data-rd-estado={rd("estado") ? status : undefined} aria-label={`${t("status")}: ${t(LABEL[status])}`}>
      {t(LABEL[status])}
    </Badge>
  );
}
