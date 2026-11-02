/**
 * GATILHOS das automações (lote 1): manual, lead criado (inclui "veio de fonte
 * de captação") e entrou na etapa (criado ou movido).
 *
 * Os gatilhos moram no nó Início do GRAFO publicado (vários por automação), não
 * numa tabela de projeção: a versão é imutável, então ler o grafo é ler a
 * verdade (DIRC — calcular em vez de duplicar).
 *
 * Esta parte é PURA: projeta a linha do `event_log` num fato de gatilho e
 * decide se um gatilho casa. O handler (`gatilhos.handler.ts`) faz o I/O.
 */
import type { EventRow } from "@/lib/event-log/dispatcher";
import { ORIGEM_DA_PLANILHA } from "@/lib/leads/planilha";
import { automacaoTriggerConfigSchema, type AutomacaoTrigger, type AutomacaoTriggerConfig } from "./schemas";
import { flowGraphSchema } from "@/lib/followup/graph-schema";


export interface FatoDeGatilho {
  tipo: "lead_created" | "stage_entered_created" | "stage_entered_moved";
  lead_id: string;
  pipeline_id: string | null;
  stage_id: string | null;
  from_stage_id: string | null;
  /** `webhook_sources.id` quando o negócio entrou por uma fonte de captação (a confirmar no banco). */
  fonte_id: string | null;
  /** O pointer que causou o evento, quando foi uma automação (anti-laço). */
  causado_pela_automacao: string | null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Quem causou o evento, se foi uma automação: `request_id = automacao:<pointer>:…`. */
export function automacaoQueCausou(row: Pick<EventRow, "metadata">): string | null {
  const rid = texto(row.metadata?.request_id);
  if (rid?.startsWith("automacao:")) return rid.split(":")[1] ?? null;
  const c = row.metadata?.caused_by_automation as { pointer_id?: unknown } | undefined;
  return texto(c?.pointer_id);
}

/** Os fatos de gatilho que UMA linha do event_log produz (lead criado também é "entrou na etapa"). */
export function fatosDoEvento(row: EventRow): FatoDeGatilho[] {
  const leadId = texto(row.entity_id);
  if (!leadId || row.entity_kind !== "crm_lead") return [];
  const causado = automacaoQueCausou(row);
  if (row.event_type === "lead.created") {
    // Planilha importada não dispara automação (mesma regra do gatilho de lead dos follow-ups).
    if (row.metadata?.via === ORIGEM_DA_PLANILHA) return [];
    const fonte =
      row.metadata?.actor_type === "webhook_source" && !causado && !texto(row.metadata?.request_id)?.startsWith("rule:")
        ? texto(row.metadata?.actor_id)
        : null;
    const base = {
      lead_id: leadId,
      pipeline_id: texto(row.payload.pipeline_id),
      stage_id: texto(row.payload.stage_id),
      from_stage_id: null,
      fonte_id: fonte,
      causado_pela_automacao: causado,
    };
    return [
      { ...base, tipo: "lead_created" },
      { ...base, tipo: "stage_entered_created" },
    ];
  }
  if (row.event_type === "lead.stage_changed") {
    const para = texto(row.payload.to_stage_id);
    if (!para) return [];
    return [
      {
        tipo: "stage_entered_moved",
        lead_id: leadId,
        pipeline_id: texto(row.payload.pipeline_id),
        stage_id: para,
        from_stage_id: texto(row.payload.from_stage_id),
        fonte_id: null,
        causado_pela_automacao: causado,
      },
    ];
  }
  return [];
}

/**
 * O gatilho casa com o fato? `fonteConfirmada` diz se `fato.fonte_id` é mesmo
 * uma fonte de captação da organização (quem confere é o handler, no banco).
 */
export function casaGatilho(gatilho: AutomacaoTrigger, fato: FatoDeGatilho, fonteConfirmada: boolean): boolean {
  switch (gatilho.kind) {
    case "manual":
      return false;
    case "lead_created": {
      if (fato.tipo !== "lead_created") return false;
      if (gatilho.pipeline_ids?.length && (!fato.pipeline_id || !gatilho.pipeline_ids.includes(fato.pipeline_id))) {
        return false;
      }
      if (gatilho.capture_source_ids?.length) {
        return fonteConfirmada && fato.fonte_id !== null && gatilho.capture_source_ids.includes(fato.fonte_id);
      }
      if (gatilho.only_capture) return fonteConfirmada && fato.fonte_id !== null;
      return true;
    }
    case "stage_entered": {
      if (fato.tipo === "lead_created") return false;
      if (!fato.stage_id || !gatilho.stage_ids.includes(fato.stage_id)) return false;
      if (fato.tipo === "stage_entered_created") return gatilho.via !== "moved";
      // Movimento para a MESMA etapa não é entrada.
      if (fato.from_stage_id === fato.stage_id) return false;
      return gatilho.via !== "created";
    }
  }
}

/** Os gatilhos declarados no Início de um grafo publicado, ou `null` se não é grafo de automação. */
export function gatilhosDoGrafo(grafo: unknown): AutomacaoTriggerConfig | null {
  const parsed = flowGraphSchema.safeParse(grafo);
  if (!parsed.success) return null;
  const inicio = parsed.data.nodes.find((n) => n.type === "trigger");
  if (!inicio) return null;
  const cfg = automacaoTriggerConfigSchema.safeParse(inicio.config);
  return cfg.success ? cfg.data : null;
}

/** O que a execução guarda do gatilho em `vars.gatilho` — projeção curta, sem PII. */
export function varsDoGatilho(fato: FatoDeGatilho, eventId: string): Record<string, unknown> {
  return {
    _lead_id: fato.lead_id,
    gatilho: {
      tipo: fato.tipo === "lead_created" ? "lead_created" : "stage_entered",
      lead_id: fato.lead_id,
      pipeline_id: fato.pipeline_id,
      stage_id: fato.stage_id,
      ...(fato.from_stage_id ? { from_stage_id: fato.from_stage_id } : {}),
      ...(fato.fonte_id ? { fonte_id: fato.fonte_id } : {}),
      event_id: eventId,
    },
  };
}
