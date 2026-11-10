import { describe, expect, it } from "vitest";

import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import { MODELOS_DE_AUTOMACAO } from "./modelos";

const ENTRADA = {
  pipelineId: "11111111-1111-4111-8111-111111111111",
  stageId: "22222222-2222-4222-8222-222222222222",
  campoDeData: "data_do_evento",
};

describe("modelos de automação", () => {
  it("ids únicos e pelo menos dois modelos", () => {
    const ids = MODELOS_DE_AUTOMACAO.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it.each(MODELOS_DE_AUTOMACAO.map((m) => [m.id, m] as const))("%s: o grafo passa no schema e no publish da automação", (_id, m) => {
    const g = flowGraphSchema.parse(m.grafo(ENTRADA));
    const v = validateFlowForPublish(g, {
      surface: "automacao",
      etapas: new Map([[ENTRADA.stageId, { id: ENTRADA.stageId, name: "Qualificado", is_archived: false }]]) as never,
      camposDeData: new Set([ENTRADA.campoDeData]),
    });
    expect(v.ok ? [] : v.errors).toEqual([]);
  });
});
