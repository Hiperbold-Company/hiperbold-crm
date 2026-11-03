/**
 * As referências a funil e etapa que um grafo de automação carrega (ações de
 * CRM, gatilhos, condições). Puro — quem confere contra o banco é o publish.
 *
 * ⚠️ Conferir no publish não é cortesia: um id de etapa de OUTRA organização
 * colado no rascunho seria executado com a service role pelo motor.
 */
import type { FlowGraph } from "@/lib/followup/graph-schema";

export function referenciasDoGrafo(graph: FlowGraph): { funis: string[]; etapas: string[] } {
  const funis = new Set<string>();
  const etapas = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type === "crm_action") {
      for (const a of n.config.actions) {
        if (a.type === "create_deal" || a.type === "move_deal") {
          funis.add(a.pipeline_id);
          etapas.add(a.stage_id);
        }
      }
    }
    if (n.type === "trigger" && "triggers" in n.config) {
      for (const g of n.config.triggers) {
        if (g.kind === "lead_created") g.pipeline_ids?.forEach((id) => funis.add(id));
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
  return { funis: [...funis], etapas: [...etapas] };
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
