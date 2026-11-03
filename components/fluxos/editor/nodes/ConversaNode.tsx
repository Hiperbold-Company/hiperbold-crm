"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches, type FlowNode } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/**
 * Card dos blocos de CONVERSA das automações (`message`, `question`). As
 * saídas vêm do registro de ramos (`nodeBranches`): na mensagem com opções,
 * uma por opção com o rótulo dela, mais "Sem resposta", "Erro" e "Resposta
 * inválida"; na pergunta, "Sem resposta", "Resposta inválida", "Erro" e
 * "Respondeu". O id de cada bolinha é o id do ramo, que é o que a aresta grava.
 */
export function ConversaNode({ id, type, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  const tipo = type as "message" | "question";
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS[tipo]}
      label={data.label}
      subtitle={describeNodeConfig(tipo, data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: tipo, config: data.config } as FlowNode)}
    />
  );
}
