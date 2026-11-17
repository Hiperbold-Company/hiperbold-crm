"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches, type FlowNode } from "@/lib/followup/graph-schema";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
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
  const conexao = (data.config as { channel_session_id?: unknown } | undefined)?.channel_session_id;
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS[tipo]}
      label={data.label}
      subtitle={describeNodeConfig(tipo, data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: tipo, config: data.config } as FlowNode)}
      {...(typeof conexao === "string" && conexao ? { detalhe: <ConexaoDoCard id={id} conexao={conexao} /> } : {})}
    />
  );
}

/**
 * A conexão escolhida no bloco (campo "Conexão"), pelo nome. Só existe quando
 * há conexão: o bloco em branco não consulta a lista.
 */
function ConexaoDoCard({ id, conexao }: { id: string; conexao: string }) {
  const t = useT();
  const canais = useChannelSessions();
  const c = (canais.data ?? []).find((x) => x.id === conexao);
  const nome = c ? channelLabel(c, t) : canais.isLoading ? "…" : t("Conexão não encontrada");
  return (
    <p className="truncate text-[11px] text-text-muted" data-testid={`node-conexao-${id}`} title={nome}>
      {t("Pela conexão")}: {nome}
    </p>
  );
}
