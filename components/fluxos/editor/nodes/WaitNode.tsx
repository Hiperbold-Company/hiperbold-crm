"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches, type FlowNode } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

export function WaitNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.wait}
      label={data.label}
      subtitle={describeNodeConfig("wait", data.config, t)}
      selected={selected}
      errors={data.errors}
      // "Até o contato responder" tem duas saídas (Respondeu, Sem resposta); as
      // outras esperas, uma só — e o card mantém a bolinha única de sempre.
      branches={nodeBranches({ type: "wait", config: data.config } as FlowNode)}
    />
  );
}
