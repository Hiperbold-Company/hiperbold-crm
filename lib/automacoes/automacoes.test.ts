import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { renderTemplate } from "@/lib/automation/template";
import { ORIGEM_DA_PLANILHA } from "@/lib/leads/planilha";
import { flowGraphSchema, nodeBranches, type FlowGraph } from "@/lib/followup/graph-schema";
import { NOS_DA_SUPERFICIE, REGISTRO_DE_NOS } from "@/lib/followup/registro-de-nos";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import { aplicarOperacao, coagirPeloTipo, dataIso } from "./campos";
import { avaliarRegraNova, comparaCampo } from "./condicoes";
import type { FatosDaAutomacao } from "./fatos";
import { casaGatilho, fatosDoEvento, gatilhosDoGrafo, varsDoGatilho } from "./gatilhos";
import { grafoInicialDaAutomacao } from "./referencias";
import { renderizar } from "./template-vars";

const FUNIL = "11111111-1111-4111-8111-111111111111";
const ETAPA_NOVO = "22222222-2222-4222-8222-222222222222";
const ETAPA_PROPOSTA = "33333333-3333-4333-8333-333333333333";
const FONTE = "44444444-4444-4444-8444-444444444444";

function fatos(over: Partial<FatosDaAutomacao> = {}): FatosDaAutomacao {
  return {
    contato: {
      id: "c1",
      name: "Maria Souza",
      email: "maria@exemplo.com",
      phone_number: "+5511999990000",
      birthdate: null,
      tags: ["VIP"],
      custom_fields: { cidade: "Campinas" },
    },
    negocio: {
      id: "l1",
      title: "Maria Souza",
      pipeline_id: FUNIL,
      stage_id: ETAPA_NOVO,
      status: "open",
      value_cents: 15000,
      owner_user_id: null,
      source: "webhook",
      tags: ["Facebook"],
      expected_close_date: null,
      custom_fields: { origem: "Facebook Ads", pontos: 3 },
    },
    negocios: [{ id: "l1", pipeline_id: FUNIL, stage_id: ETAPA_NOVO, status: "open" }],
    vars: { gatilho: { tipo: "lead_created", lead_id: "l1" } },
    ...over,
  };
}

describe("operação de campo: coerção pelo tipo do campo", () => {
  it("número aceita formato brasileiro e recusa texto", () => {
    expect(coagirPeloTipo({ type: "number" }, "1.234,50")).toEqual({ ok: true, valor: 1234.5 });
    expect(coagirPeloTipo({ type: "number" }, "abc")).toEqual({ ok: false, erro: "valor_invalido:numero" });
  });
  it("data aceita DD/MM/AAAA e recusa dia que não existe", () => {
    expect(dataIso("31/12/2026")).toBe("2026-12-31");
    expect(dataIso("31/02/2026")).toBeNull();
  });
  it("opção casa pelo valor ou pelo rótulo, sem distinguir maiúsculas", () => {
    const def = { type: "select" as const, options: [{ value: "fb", label: "Facebook" }] };
    expect(coagirPeloTipo(def, "facebook")).toEqual({ ok: true, valor: "fb" });
    expect(coagirPeloTipo(def, "Google").ok).toBe(false);
  });
  it("campo sem definição grava o texto como veio", () => {
    expect(coagirPeloTipo(null, "qualquer coisa")).toEqual({ ok: true, valor: "qualquer coisa" });
  });
  it("somar só vale em número; acrescentar só em texto", () => {
    expect(aplicarOperacao("increment", 3, "2", { type: "number" })).toEqual({ ok: true, valor: 5 });
    expect(aplicarOperacao("increment", null, "2", null)).toEqual({ ok: true, valor: 2 });
    expect(aplicarOperacao("increment", "x", "2", { type: "text" }).ok).toBe(false);
    expect(aplicarOperacao("append", "Olá", "mundo", null)).toEqual({ ok: true, valor: "Olá mundo" });
    expect(aplicarOperacao("append", ["a"], "b", null)).toEqual({ ok: true, valor: ["a", "b"] });
    expect(aplicarOperacao("clear", "algo", "", null)).toEqual({ ok: true, valor: null });
  });
});

describe("condições novas", () => {
  it("campo contém, sem distinguir maiúsculas (o cenário Origem contém facebook)", () => {
    const regra = {
      kind: "field" as const,
      field: { scope: "lead_custom" as const, key: "origem" },
      op: "contains" as const,
      value: "facebook",
    };
    expect(avaliarRegraNova(regra, fatos())).toBe(true);
    expect(avaliarRegraNova({ ...regra, value: "google" }, fatos())).toBe(false);
  });
  it("o desconhecido nunca satisfaz uma negação", () => {
    expect(comparaCampo(undefined, "neq", "x")).toBe(false);
    expect(comparaCampo(undefined, "not_contains", "x")).toBe(false);
    expect(comparaCampo(undefined, "empty", undefined)).toBe(true);
    const semNegocio = fatos({ negocio: null, negocios: [] });
    expect(avaliarRegraNova({ kind: "stage", op: "not_in", stage_ids: [ETAPA_NOVO] }, semNegocio)).toBe(false);
  });
  it("número compara como número, e texto que não é número não passa", () => {
    expect(comparaCampo(3, "gte", 3)).toBe(true);
    expect(comparaCampo("10", "gt", "9")).toBe(true);
    expect(comparaCampo("abc", "gt", 1)).toBe(false);
  });
  it("tag, etapa, negócio aberto no funil, negócio existe e situação", () => {
    const f = fatos();
    expect(avaliarRegraNova({ kind: "tag", target: "contact", op: "has_any", tags: ["vip"] }, f)).toBe(true);
    expect(avaliarRegraNova({ kind: "tag", target: "lead", op: "has_none", tags: ["Facebook"] }, f)).toBe(false);
    expect(avaliarRegraNova({ kind: "stage", op: "in", stage_ids: [ETAPA_NOVO] }, f)).toBe(true);
    expect(avaliarRegraNova({ kind: "open_deal_in_pipeline", pipeline_id: FUNIL }, f)).toBe(true);
    expect(avaliarRegraNova({ kind: "deal_exists" }, fatos({ negocios: [] }))).toBe(false);
    expect(avaliarRegraNova({ kind: "deal_status", status: "won" }, f)).toBe(false);
  });
  it("sem fatos (motor de follow-up) nenhuma regra nova passa", () => {
    expect(avaliarRegraNova({ kind: "deal_exists" }, undefined)).toBe(false);
  });
});

describe("variáveis nos textos", () => {
  it("{{campo.x}} lê o campo personalizado do negócio e, sem ele, o do contato", () => {
    const ctx = { lead: { custom_fields: { origem: "Facebook" } }, contact: { custom_fields: { cidade: "Campinas" } } };
    expect(renderTemplate("{{campo.origem}} / {{campo.cidade}}", ctx)).toBe("Facebook / Campinas");
  });
  it("contact, lead, gatilho e sistema numa automação", () => {
    const agora = new Date("2026-11-02T15:30:00Z");
    expect(renderizar("{{contact.name}} | {{lead.title}} | {{gatilho.tipo}} | {{sistema.data}} {{sistema.hora}}", fatos(), agora)).toBe(
      "Maria Souza | Maria Souza | lead_created | 02/11/2026 12:30",
    );
  });
});

function evento(over: Partial<EventRow>): EventRow {
  return {
    id: "e1",
    organization_id: "o1",
    event_type: "lead.created",
    entity_kind: "crm_lead",
    entity_id: "l1",
    payload: { pipeline_id: FUNIL, stage_id: ETAPA_NOVO },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

describe("gatilhos", () => {
  it("lead criado também é 'entrou na etapa' (criado)", () => {
    const fatosDoLead = fatosDoEvento(evento({}));
    expect(fatosDoLead.map((f) => f.tipo)).toEqual(["lead_created", "stage_entered_created"]);
    const [criado, naEtapa] = fatosDoLead;
    expect(casaGatilho({ kind: "lead_created" }, criado!, false)).toBe(true);
    expect(casaGatilho({ kind: "stage_entered", stage_ids: [ETAPA_NOVO], via: "any" }, naEtapa!, false)).toBe(true);
    expect(casaGatilho({ kind: "stage_entered", stage_ids: [ETAPA_NOVO], via: "moved" }, naEtapa!, false)).toBe(false);
  });
  it("filtro de funil e de fonte de captação", () => {
    const [criado] = fatosDoEvento(
      evento({ metadata: { actor_type: "webhook_source", actor_id: FONTE, request_id: "req-1" } }),
    );
    expect(criado!.fonte_id).toBe(FONTE);
    expect(casaGatilho({ kind: "lead_created", capture_source_ids: [FONTE] }, criado!, true)).toBe(true);
    // Fonte que o banco não confirmou não conta.
    expect(casaGatilho({ kind: "lead_created", only_capture: true }, criado!, false)).toBe(false);
    expect(casaGatilho({ kind: "lead_created", pipeline_ids: ["99999999-9999-4999-8999-999999999999"] }, criado!, true)).toBe(
      false,
    );
  });
  it("mover para a mesma etapa não é entrada; mover para outra é", () => {
    const mover = (de: string, para: string) =>
      fatosDoEvento(
        evento({ event_type: "lead.stage_changed", payload: { pipeline_id: FUNIL, from_stage_id: de, to_stage_id: para } }),
      )[0]!;
    const g = { kind: "stage_entered" as const, stage_ids: [ETAPA_PROPOSTA], via: "any" as const };
    expect(casaGatilho(g, mover(ETAPA_NOVO, ETAPA_PROPOSTA), false)).toBe(true);
    expect(casaGatilho(g, mover(ETAPA_PROPOSTA, ETAPA_PROPOSTA), false)).toBe(false);
  });
  it("planilha importada não dispara, e o evento guarda quem o causou (anti-laço)", () => {
    expect(fatosDoEvento(evento({ metadata: { via: ORIGEM_DA_PLANILHA } }))).toEqual([]);
    const [f] = fatosDoEvento(evento({ metadata: { request_id: "automacao:ptr-1:enr-1:n2:3" } }));
    expect(f!.causado_pela_automacao).toBe("ptr-1");
  });
  it("as variáveis do gatilho levam o negócio da execução", () => {
    const [f] = fatosDoEvento(evento({}));
    expect(varsDoGatilho(f!, "e1")).toMatchObject({ _lead_id: "l1", gatilho: { tipo: "lead_created", event_id: "e1" } });
  });
});

/** O cenário da prova: Lead criado → Origem contém facebook → ações → Fim. */
function grafoDoCenario(valor = "facebook"): FlowGraph {
  return flowGraphSchema.parse({
    nodes: [
      {
        id: "n1",
        type: "trigger",
        label: "Início",
        position: { x: 0, y: 0 },
        config: { triggers: [{ kind: "lead_created" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
      },
      {
        id: "n2",
        type: "condition",
        label: "Veio do Facebook?",
        position: { x: 0, y: 100 },
        config: {
          combinator: "and",
          checks: [{ kind: "field", field: { scope: "lead_custom", key: "origem" }, op: "contains", value: valor }],
        },
      },
      {
        id: "n3",
        type: "crm_action",
        label: "Criar negócio e tag",
        position: { x: 0, y: 200 },
        config: {
          actions: [
            { type: "create_deal", pipeline_id: FUNIL, stage_id: ETAPA_NOVO, if_open_exists: "skip" },
            { type: "add_tags", target: "lead", tags: ["Facebook"] },
          ],
          on_error: "route",
        },
      },
      {
        id: "n4",
        type: "field_op",
        label: "Definir campo",
        position: { x: 0, y: 300 },
        config: { ops: [{ target: { scope: "lead_custom", key: "canal" }, op: "set", value: "facebook" }] },
      },
      { id: "n5", type: "end", label: "Fim", position: { x: 0, y: 400 }, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", priority: 0, condition: { type: "always" } },
      { id: "e2", source: "n2", target: "n3", priority: 0, condition: { type: "cond_result", value: true } },
      { id: "e3", source: "n2", target: "n5", priority: 1, condition: { type: "cond_result", value: false } },
      { id: "e4", source: "n3", target: "n4", priority: 0, condition: { type: "always" } },
      { id: "e5", source: "n3", target: "n5", priority: 1, condition: { type: "branch", branch_id: "erro" } },
      { id: "e6", source: "n4", target: "n5", priority: 0, condition: { type: "always" } },
      { id: "e7", source: "n4", target: "n5", priority: 1, condition: { type: "branch", branch_id: "erro" } },
    ],
  });
}

describe("registro de nós e publish da automação", () => {
  it("a paleta da automação oferece só o que o motor dela executa", () => {
    expect([...NOS_DA_SUPERFICIE.automacao].sort()).toEqual(
      ["condition", "crm_action", "end", "field_op", "trigger", "wait"].sort(),
    );
    expect(NOS_DA_SUPERFICIE.followup).not.toContain("crm_action");
    expect(REGISTRO_DE_NOS.crm_action.efeito).toBe(true);
    expect(REGISTRO_DE_NOS.condition.efeito).toBe(false);
  });
  it("bloco de efeito tem duas saídas: Erro e Concluído", () => {
    const ramos = nodeBranches({ type: "field_op", config: { ops: [{ target: { scope: "lead", key: "title" }, op: "clear" }] } });
    expect(ramos.map((r) => r.label)).toEqual(["Erro", "Concluído"]);
  });
  it("o cenário da prova publica", () => {
    expect(validateFlowForPublish(grafoDoCenario(), { surface: "automacao" })).toEqual({ ok: true });
    expect(gatilhosDoGrafo(grafoDoCenario())?.triggers).toEqual([{ kind: "lead_created" }]);
  });
  it("regra de campo sem valor e Início sem gatilho são recusados com motivo", () => {
    const r = validateFlowForPublish(grafoDoCenario(""), { surface: "automacao" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("empty_check_value");
    const semGatilho = grafoDoCenario();
    semGatilho.nodes[0] = { ...semGatilho.nodes[0]!, config: {} } as FlowGraph["nodes"][number];
    const r2 = validateFlowForPublish(semGatilho, { surface: "automacao" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.map((e) => e.code)).toContain("gatilho_da_automacao");
  });
  it("bloco de follow-up não publica numa automação", () => {
    const g = grafoDoCenario();
    g.nodes.push({
      id: "n9",
      type: "action",
      label: "Mensagem",
      position: { x: 0, y: 0 },
      config: { mode: "text", body: "Oi" },
    } as unknown as FlowGraph["nodes"][number]);
    const r = validateFlowForPublish(g, { surface: "automacao" });
    expect(r.ok).toBe(false);
  });
  it("a automação nova nasce com Início manual ligado ao Fim, e é grafo válido", () => {
    const g = grafoInicialDaAutomacao();
    expect(flowGraphSchema.safeParse(g).success).toBe(true);
    expect(gatilhosDoGrafo(g)?.triggers).toEqual([{ kind: "manual" }]);
  });
});
