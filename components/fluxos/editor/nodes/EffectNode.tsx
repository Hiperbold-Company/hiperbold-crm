"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches, type FlowNode } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import { useNomesDaAutomacao } from "../forms/automacao/comum";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/**
 * Card dos blocos de EFEITO das automações (`crm_action`, `field_op`): duas
 * saídas, "Concluído" e "Erro", vindas do registro de ramos.
 */
export function EffectNode({ id, type, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  const tipo = type as "crm_action" | "field_op";
  // O card diz o NOME da automação, etapa ou pessoa escolhida, como o formulário.
  const nomes = useNomesDaAutomacao();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS[tipo]}
      label={data.label}
      subtitle={describeNodeConfig(tipo, data.config, t, undefined, nomes)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: tipo, config: data.config } as FlowNode)}
    />
  );
}
