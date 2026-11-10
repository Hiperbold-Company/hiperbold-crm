import { describe, expect, it } from "vitest";

import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { TRIGGER_EVENTS, actionSchema } from "@/lib/schemas/webhooks";

import { ACOES_SEM_EQUIVALENTE, GATILHOS_SEM_EQUIVALENTE, converterRegra, type RegraAntiga } from "./converter-regra";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const TAG = { type: "add_tag", config: { tags: ["vip"] } };

function regra(p: Partial<RegraAntiga>): RegraAntiga {
  return { id: U1, name: "Regra", trigger_event: "lead.created", trigger_config: {}, conditions: [], actions: [TAG], ...p };
}

/** O grafo convertido passa no schema E no publish da superfície `automacao`. */
function publicavel(r: RegraAntiga) {
  const res = converterRegra(r);
  expect(res.naoConvertido).toEqual([]);
  if (!res.conversivel) throw new Error("não converteu");
  const g = flowGraphSchema.parse(res.grafo);
  const v = validateFlowForPublish(g, { surface: "automacao" });
  expect(v.ok ? [] : v.errors).toEqual([]);
  return res.grafo;
}

const gatilhoDe = (g: { nodes: { type: string; config: unknown }[] }) =>
  (g.nodes.find((n) => n.type === "trigger")!.config as { triggers: unknown[] }).triggers[0];
const acoesDe = (g: { nodes: { type: string; config: unknown }[] }) =>
  (g.nodes.find((n) => n.type === "crm_action")!.config as { actions: unknown[] }).actions;
const checksDe = (g: { nodes: { type: string; config: unknown }[] }) =>
  (g.nodes.find((n) => n.type === "condition")?.config as { checks: unknown[]; combinator: string } | undefined);

describe("converterRegra — gatilhos com equivalente", () => {
  it("lead.created → lead_created; com fonte, a fonte vai junto", () => {
    expect(gatilhoDe(publicavel(regra({})))).toEqual({ kind: "lead_created" });
    expect(gatilhoDe(publicavel(regra({ trigger_config: { webhook_source_id: U2 } })))).toEqual({
      kind: "lead_created",
      capture_source_ids: [U2],
    });
  });

  it("lead.stage_changed com a etapa fixada vira stage_entered (a condição da etapa sai)", () => {
    const g = publicavel(
      regra({ trigger_event: "lead.stage_changed", conditions: [{ field: "lead.stage_id", op: "eq", value: U2 }] }),
    );
    expect(gatilhoDe(g)).toEqual({ kind: "stage_entered", stage_ids: [U2], via: "moved" });
    expect(checksDe(g)).toBeUndefined();
  });

  it.each(["lead.tag_added", "contact.tag_added"])("%s com a etiqueta fixada vira tag_added", (ev) => {
    const g = publicavel(regra({ trigger_event: ev, conditions: [{ field: "event.added_tags", op: "contains", value: "quente" }] }));
    expect(gatilhoDe(g)).toEqual({ kind: "tag_added", target: ev === "lead.tag_added" ? "lead" : "contact", tags: ["quente"] });
  });

  it.each(["created", "confirmed", "rescheduled", "cancelled", "completed", "no_show"])("appointment.%s → appointment", (e) => {
    expect(gatilhoDe(publicavel(regra({ trigger_event: `appointment.${e}` })))).toEqual({ kind: "appointment", events: [e] });
  });

  it("contact.birthday no dia → birthday; message.received → message_received sem olhar humano", () => {
    expect(gatilhoDe(publicavel(regra({ trigger_event: "contact.birthday" })))).toEqual({ kind: "birthday" });
    expect(gatilhoDe(publicavel(regra({ trigger_event: "message.received" })))).toEqual({
      kind: "message_received",
      match: "any",
      keywords: [],
      skip_if_human: false,
    });
  });
});

describe("converterRegra — condições com equivalente", () => {
  it("campos, etiquetas, etapa e operadores", () => {
    const g = publicavel(
      regra({
        conditions: {
          any: [
            { field: "lead.title", op: "contains", value: "Plano" },
            { field: "lead.custom_fields.origem", op: "eq", value: "facebook" },
            { field: "contact.email", op: "is_not_empty", value: "" },
            { field: "contact.custom_fields.cidade", op: "is_empty", value: "" },
            { field: "lead.value_cents", op: "gte", value: "1000" },
            { field: "lead.tags", op: "contains", value: "vip" },
            { field: "contact.tags", op: "not_contains", value: "bloq" },
            { field: "lead.stage_id", op: "neq", value: U2 },
            { field: "lead.expected_close_date", op: "lt", value: "2026-12-01" },
          ],
        },
      }),
    );
    const c = checksDe(g)!;
    expect(c.combinator).toBe("or");
    expect(c.checks).toEqual([
      { kind: "field", field: { scope: "lead", key: "title" }, op: "contains", value: "Plano" },
      { kind: "field", field: { scope: "lead_custom", key: "origem" }, op: "eq", value: "facebook" },
      { kind: "field", field: { scope: "contact", key: "email" }, op: "has_value" },
      { kind: "field", field: { scope: "contact_custom", key: "cidade" }, op: "empty" },
      { kind: "field", field: { scope: "lead", key: "value_cents" }, op: "gte", value: 1000 },
      { kind: "tag", target: "lead", op: "has_any", tags: ["vip"] },
      { kind: "tag", target: "contact", op: "has_none", tags: ["bloq"] },
      { kind: "stage", op: "not_in", stage_ids: [U2] },
      { kind: "field", field: { scope: "lead", key: "expected_close_date" }, op: "lt", value: "2026-12-01" },
    ]);
  });
});

describe("converterRegra — ações com equivalente", () => {
  it("etiqueta, responsável fixo e tarefa média viram um bloco de ações, na ordem", () => {
    const g = publicavel(
      regra({
        actions: [
          { type: "add_tag", config: { tags: ["a"], destino: "contato" } },
          { type: "add_tag", config: { tags: ["b"] } },
          { type: "assign_owner", config: { user_id: U2 } },
          { type: "create_task", config: { titulo: "Ligar", vence_em_dias: 2, atribuir_a: "dono_do_lead", prioridade: "medium" } },
          { type: "create_task", config: { titulo: "Ver", vence_em_dias: 0, atribuir_a: { usuario_id: U2 }, prioridade: "medium" } },
        ],
      }),
    );
    expect(acoesDe(g)).toEqual([
      { type: "add_tags", target: "contact", tags: ["a"] },
      { type: "add_tags", target: "lead", tags: ["b"] },
      { type: "set_owner", mode: { m: "user", user_id: U2 } },
      { type: "create_task", title: "Ligar", due_in_minutes: 2880, assignee: "owner" },
      { type: "create_task", title: "Ver", due_in_minutes: 0, assignee: U2 },
    ]);
  });
});

describe("converterRegra — sem equivalente: a regra inteira fica no motor antigo", () => {
  it("todo gatilho do motor antigo ou converte ou tem motivo escrito", () => {
    for (const ev of TRIGGER_EVENTS) {
      const r = converterRegra(regra({ trigger_event: ev }));
      if (r.conversivel) continue;
      const g = r.naoConvertido.find((n) => n.parte === "gatilho");
      expect(g?.motivo, ev).toBeTruthy();
    }
    for (const ev of Object.keys(GATILHOS_SEM_EQUIVALENTE)) {
      const r = converterRegra(regra({ trigger_event: ev }));
      expect(r.conversivel, ev).toBe(false);
      expect(r.naoConvertido[0]).toMatchObject({ parte: "gatilho", item: ev, motivo: GATILHOS_SEM_EQUIVALENTE[ev] });
    }
  });

  it("toda ação do motor antigo ou converte ou tem motivo escrito", () => {
    const tipos = actionSchema.options.map((o) => o.shape.type.value);
    for (const tipo of tipos) {
      if (["add_tag", "assign_owner", "create_task"].includes(tipo)) continue;
      expect(ACOES_SEM_EQUIVALENTE[tipo], tipo).toBeTruthy();
      const r = converterRegra(regra({ actions: [TAG, { type: tipo, config: {} }] }));
      expect(r.conversivel).toBe(false);
      expect(r.grafo).toBeNull();
      expect(r.naoConvertido).toEqual([{ parte: "acao", indice: 1, item: tipo, motivo: ACOES_SEM_EQUIVALENTE[tipo] }]);
    }
  });

  it.each([
    ["mudou de etapa sem etapa fixada", { trigger_event: "lead.stage_changed" }],
    ["etiqueta sem etiqueta fixada", { trigger_event: "lead.tag_added" }],
    ["etapa fixada num OU", { trigger_event: "lead.stage_changed", conditions: { any: [{ field: "lead.stage_id", op: "eq", value: U2 }, { field: "lead.title", op: "eq", value: "x" }] } }],
    ["uma vez por contato", { trigger_config: { uma_vez_por_contato: true } }],
    ["aniversário com antecedência", { trigger_event: "contact.birthday", trigger_config: { dias_antecedencia: 3 } }],
    ["condição do evento", { conditions: [{ field: "message.text", op: "contains", value: "oi" }] }],
    ["condição do contato no banco", { conditions: [{ field: "contato.followup_vivo", op: "eq", value: "sim" }] }],
    ["maior que com texto", { conditions: [{ field: "lead.title", op: "gt", value: "abc" }] }],
    ["grupo aninhado", { conditions: { all: [{ any: [] }] } }],
    ["rodízio", { actions: [{ type: "assign_owner", config: { modo: "rodizio", fila: [] } }] }],
    ["responsável levando contato", { actions: [{ type: "assign_owner", config: { user_id: U2, contato: true } }] }],
    ["tarefa urgente", { actions: [{ type: "create_task", config: { titulo: "x", vence_em_dias: 1, atribuir_a: "dono_do_lead", prioridade: "urgent" } }] }],
    ["sem ações", { actions: [] }],
  ] as const)("%s → não conversível, com motivo", (_nome, p) => {
    const r = converterRegra(regra(p as Partial<RegraAntiga>));
    expect(r.conversivel).toBe(false);
    expect(r.grafo).toBeNull();
    expect(r.naoConvertido.length).toBeGreaterThan(0);
    for (const n of r.naoConvertido) expect(n.motivo.length).toBeGreaterThan(10);
  });

  it("webhook com segredo nunca leva o segredo para lugar nenhum", () => {
    const r = converterRegra(regra({ actions: [{ type: "call_webhook", config: { url: "https://x.test", secret_enc: "abcd" } }] }));
    expect(r.conversivel).toBe(false);
    expect(JSON.stringify(r)).not.toContain("abcd");
  });
});
