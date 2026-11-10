/**
 * As referências a funil, etapa, pessoa da equipe e fonte de captação que um grafo de automação carrega (ações de
 * CRM, gatilhos, condições). Puro — quem confere contra o banco é o publish.
 *
 * ⚠️ Conferir no publish não é cortesia: um id de etapa de OUTRA organização
 * colado no rascunho seria executado com a service role pelo motor.
 */
import type { FlowGraph } from "@/lib/followup/graph-schema";

import { segredosDoBloco } from "./http";

export interface ReferenciasDoGrafo {
  funis: string[];
  etapas: string[];
  /** Pessoas citadas (dono, rodízio, aviso, responsável da tarefa): membros ativos desta organização. */
  pessoas: string[];
  /** Fontes de captação (`webhook_sources`) do gatilho "lead criado". */
  fontes: string[];
  /** Automações que a ação "Iniciar outra automação" inicia: desta organização e da superfície `automacao`. */
  automacoes: string[];
  /** Chaves do cofre (`automacao_segredos`) citadas pelos blocos "Requisição HTTP": desta organização. */
  segredos: string[];
}

export function referenciasDoGrafo(graph: FlowGraph): ReferenciasDoGrafo {
  const funis = new Set<string>();
  const etapas = new Set<string>();
  const pessoas = new Set<string>();
  const fontes = new Set<string>();
  const automacoes = new Set<string>();
  const segredos = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type === "http_request") segredosDoBloco(n.config).forEach((id) => segredos.add(id));
    if (n.type === "crm_action") {
      for (const a of n.config.actions) {
        if (a.type === "create_deal" || a.type === "move_deal") {
          funis.add(a.pipeline_id);
          etapas.add(a.stage_id);
        }
        if (a.type === "set_owner") {
          if (a.mode.m === "user") pessoas.add(a.mode.user_id);
          if (a.mode.m === "round_robin") a.mode.user_ids?.forEach((id) => pessoas.add(id));
        }
        if (a.type === "notify" && Array.isArray(a.to)) a.to.forEach((id) => pessoas.add(id));
        if (a.type === "create_task" && a.assignee !== "owner") pessoas.add(a.assignee);
        if (a.type === "start_automation") automacoes.add(a.pointer_id);
      }
    }
    if (n.type === "trigger" && "triggers" in n.config) {
      for (const g of n.config.triggers) {
        if (g.kind === "lead_created") {
          g.pipeline_ids?.forEach((id) => funis.add(id));
          g.capture_source_ids?.forEach((id) => fontes.add(id));
        }
        if (g.kind === "stage_entered") g.stage_ids.forEach((id) => etapas.add(id));
      }
    }
    if (n.type === "condition") {
      for (const c of n.config.checks) {
        if (!("kind" in c)) continue;
        if (c.kind === "stage") c.stage_ids.forEach((id) => etapas.add(id));
        if (c.kind === "open_deal_in_pipeline") funis.add(c.pipeline_id);
      }
    }
  }
  return { funis: [...funis], etapas: [...etapas], pessoas: [...pessoas], fontes: [...fontes], automacoes: [...automacoes], segredos: [...segredos] };
}

/** Grafo com que uma automação nova nasce: Início (gatilho manual) → Fim. */
export function grafoInicialDaAutomacao(): FlowGraph {
  return {
    nodes: [
      {
        id: "n1",
        type: "trigger",
        label: "Início",
        position: { x: 0, y: 0 },
        config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
      },
      { id: "n2", type: "end", label: "Fim", position: { x: 0, y: 200 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2", priority: 0, condition: { type: "always" } }],
  };
}
