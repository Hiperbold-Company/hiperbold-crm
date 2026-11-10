"use client";

import { Card } from "@/components/ui/card";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";
import type { AutomacaoTriggerConfig, CrmActionConfig } from "@/lib/automacoes/schemas";
import {
  GATILHOS_DA_AUTOMACAO,
  fraseDaAcao,
  fraseDaRegraNova,
  type NomesDaAutomacao,
} from "@/lib/automacoes/vocabulario";
import type { FlowNode, NovaConditionCheck } from "@/lib/followup/graph-schema";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

/**
 * Os blocos que a automação nova teria. Os nomes de etapa vêm do servidor; os das pessoas saem da MESMA
 * listagem que o editor usa no bloco "Definir responsável" (`useAssignableMembers` + `rotuloDoMembro`),
 * nunca o id cru.
 */
export function BlocosDaConversao({
  nodes,
  etapas,
}: {
  nodes: FlowNode[];
  etapas: Record<string, string>;
}) {
  const t = useT();
  const membros = useAssignableMembers(true);
  const pessoas = new Map((membros.data ?? []).map((m) => [m.user_id, rotuloDoMembro(m, t)]));
  const nomes: NomesDaAutomacao = {
    etapa: (id) => etapas[id] ?? null,
    // Sem a listagem (carregando ou pessoa fora da equipe ativa), nunca mostra o id.
    pessoa: (id) => pessoas.get(id) ?? t("um responsável da equipe"),
  };

  return (
    <ol className="space-y-3" data-testid="blocos-da-conversao">
      {nodes.map((n) => (
        <li key={n.id}>
          <Card className="space-y-1 p-4">
            <p className="text-xs font-medium text-text-muted uppercase">{t(n.label)}</p>
            {n.type === "trigger" &&
              (n.config as AutomacaoTriggerConfig).triggers.map((g, i) => (
                <p key={i} className="text-sm">
                  {t("Quando")}: {t(GATILHOS_DA_AUTOMACAO[g.kind])}
                </p>
              ))}
            {n.type === "condition" &&
              (n.config as { checks: NovaConditionCheck[]; combinator: "and" | "or" }).checks.map(
                (c, i) => (
                  <p key={i} className="text-sm">
                    {i > 0 &&
                      ((n.config as { combinator: string }).combinator === "or"
                        ? `${t("ou")} `
                        : `${t("e")} `)}
                    {fraseDaRegraNova(c, nomes)}
                  </p>
                ),
              )}
            {n.type === "crm_action" &&
              (n.config as CrmActionConfig).actions.map((a, i) => (
                <p key={i} className="text-sm">
                  {fraseDaAcao(a, nomes)}
                </p>
              ))}
          </Card>
        </li>
      ))}
    </ol>
  );
}
