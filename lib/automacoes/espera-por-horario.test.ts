/**
 * Lote 6 das Automações: as esperas por horário no MOTOR (decisão do nó), a
 * condição "Está no horário?", a publicação e a reatividade.
 */
import { describe, expect, it } from "vitest";

import { avaliarRegraNova, estaNoHorario } from "@/lib/automacoes/condicoes";
import { instanteAteODia } from "@/lib/automacoes/plano-de-tempo";
import { descreveEvento, resumoDoNo } from "@/lib/followup/eventos-legiveis";
import {
  duracaoMaximaDaEspera,
  duracaoMinimaDaEspera,
  flowGraphSchema,
  MOTIVO_SEM_DATA_NO_CAMPO,
  nodeBranches,
  waitConfigSchema,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "@/lib/followup/graph-schema";
import { processNode, type EnrollmentRow, type LeadFacts } from "@/lib/followup/node-handlers";
import { esperaDeTempoPuro } from "@/lib/followup/reactivity";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

const SP = "America/Sao_Paulo";
const COMERCIAL = { start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] };
// Terça 10/11/2026 10:00 em SP.
const TERCA_10H = new Date("2026-11-10T13:00:00.000Z");

function inscricao(over: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: null,
    current_node_id: "espera",
    status: "active",
    next_eval_at: TERCA_10H.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 3,
    outcome: null,
    cancel_reason: null,
    started_at: TERCA_10H.toISOString(),
    completed_at: null,
    updated_at: TERCA_10H.toISOString(),
    lane: "automacao",
    ...over,
  } as EnrollmentRow;
}
const lead = (over: Partial<LeadFacts> = {}): LeadFacts => ({
  lead_stage: null,
  tags: [],
  steps_taken: 3,
  last_outcome: null,
  fuso: SP,
  ...over,
});
const espera = (config: Record<string, unknown>) =>
  ({
    id: "espera",
    type: "wait",
    label: "Espera",
    position: { x: 0, y: 0 },
    config,
  }) as unknown as FlowNode;
const SEGUE: FlowEdge = {
  id: "e",
  source: "espera",
  target: "envio",
  priority: 0,
  condition: { type: "always" },
};
const SEM_DATA: FlowEdge = {
  id: "s",
  source: "espera",
  target: "aviso",
  priority: 1,
  condition: { type: "branch", branch_id: "sem_data" },
};

const decidir = (
  config: Record<string, unknown>,
  agora: Date,
  over: {
    waitElapsed?: boolean;
    edges?: FlowEdge[];
    lead?: LeadFacts;
    negocio?: Record<string, unknown>;
  } = {},
) =>
  processNode({
    node: espera(config),
    edges: over.edges ?? [SEGUE],
    enrollment: inscricao(),
    lead: over.lead ?? lead(),
    clock: () => agora,
    waitElapsed: over.waitElapsed ?? false,
    ...(over.negocio
      ? {
          fatos: {
            contato: null,
            negocios: [],
            vars: {},
            negocio: { custom_fields: over.negocio } as never,
          },
        }
      : {}),
  });

describe("espera até um dia e horário (until_time)", () => {
  it("amanhã 09:00: estaciona até quarta 09:00 local", () => {
    expect(decidir({ mode: "until_time", when: "tomorrow", time: "09:00" }, TERCA_10H)).toEqual({
      kind: "wait",
      next_eval_at: new Date("2026-11-11T12:00:00.000Z"),
    });
  });

  it("hoje 09:00 às 10:00: já passou, segue na hora sem esperar", () => {
    expect(decidir({ mode: "until_time", when: "today", time: "09:00" }, TERCA_10H)).toMatchObject({
      kind: "advance",
      next_node_id: "envio",
    });
  });

  it("com 'só no horário', o sábado vira segunda 09:00", () => {
    const sexta = new Date("2026-11-13T13:00:00.000Z"); // sex 10:00
    expect(
      decidir(
        { mode: "until_time", when: "tomorrow", time: "10:00", ate_o_horario: COMERCIAL },
        sexta,
      ),
    ).toEqual({ kind: "wait", next_eval_at: new Date("2026-11-16T12:00:00.000Z") });
  });

  it("ao acordar (waitElapsed), segue", () => {
    expect(
      decidir({ mode: "until_time", when: "tomorrow", time: "09:00" }, TERCA_10H, {
        waitElapsed: true,
      }),
    ).toMatchObject({
      kind: "advance",
      next_node_id: "envio",
    });
  });
});

describe("espera em segundos com horário (delay + ate_o_horario)", () => {
  it("fora do horário na saída: continua até a abertura", () => {
    const domingo = new Date("2026-11-15T13:00:00.000Z");
    expect(
      decidir({ mode: "delay", duration_s: 5, ate_o_horario: COMERCIAL }, domingo, {
        waitElapsed: true,
      }),
    ).toEqual({
      kind: "wait",
      next_eval_at: new Date("2026-11-16T12:00:00.000Z"),
    });
  });

  it("sem horário, segue como antes (5 s)", () => {
    expect(decidir({ mode: "delay", duration_s: 5 }, TERCA_10H)).toEqual({
      kind: "wait",
      next_eval_at: new Date(TERCA_10H.getTime() + 5000),
    });
  });
});

describe("espera até a data de um campo (until_date_field)", () => {
  const cfg = { mode: "until_date_field", field_key: "visita", offset_days: -1, time: "09:00" };

  it("lê o campo do negócio da execução e estaciona até 1 dia antes, 09:00", () => {
    expect(
      decidir(cfg, TERCA_10H, { negocio: { visita: "20/11/2026" }, edges: [SEGUE, SEM_DATA] }),
    ).toEqual({
      kind: "wait",
      next_eval_at: new Date("2026-11-19T12:00:00.000Z"),
    });
  });

  it("sem negócio nos fatos, lê o custom_fields do lead", () => {
    expect(
      decidir(cfg, TERCA_10H, {
        lead: lead({ custom_fields: { visita: "2026-11-20" } }),
        edges: [SEGUE, SEM_DATA],
      }),
    ).toEqual({
      kind: "wait",
      next_eval_at: new Date("2026-11-19T12:00:00.000Z"),
    });
  });

  it("execução COM negócio sem o campo não lê a data de outro negócio do contato: sai por 'Sem data'", () => {
    expect(
      decidir(cfg, TERCA_10H, {
        negocio: {}, // o negócio da execução não tem o campo
        lead: lead({ custom_fields: { visita: "2026-11-20" } }), // o card mais recente do contato, que é OUTRO
        edges: [SEGUE, SEM_DATA],
      }),
    ).toMatchObject({ kind: "advance", next_node_id: "aviso", class: "sem_data" });
  });

  it("campo vazio ou data já passada: sai por 'Sem data'", () => {
    for (const visita of ["", "2026-11-10", "texto"]) {
      expect(
        decidir(cfg, TERCA_10H, { negocio: { visita }, edges: [SEGUE, SEM_DATA] }),
      ).toMatchObject({
        kind: "advance",
        next_node_id: "aviso",
        class: "sem_data",
      });
    }
  });

  it("'Sem data' sem aresta ligada termina a execução — nunca segue pelo caminho da data", () => {
    expect(decidir(cfg, TERCA_10H, { negocio: { visita: "" } })).toEqual({
      kind: "complete",
      outcome: null,
      cancel_reason: MOTIVO_SEM_DATA_NO_CAMPO,
    });
  });

  it("o bloco desenha as duas saídas", () => {
    expect(nodeBranches(espera(cfg) as never).map((b) => b.id)).toEqual(["sem_data", "else"]);
  });
});

describe("condição 'Está no horário?' (business_hours)", () => {
  const regra = { kind: "business_hours" as const, ...COMERCIAL };

  it("terça 10:00 está; terça 19:00 e domingo não", () => {
    expect(estaNoHorario(regra, TERCA_10H, SP)).toBe(true);
    expect(estaNoHorario(regra, new Date("2026-11-10T22:00:00.000Z"), SP)).toBe(false);
    expect(estaNoHorario(regra, new Date("2026-11-15T13:00:00.000Z"), SP)).toBe(false);
  });

  it("o fuso é o da organização: 10:00 em SP é 08:00 em Rio Branco (fechado)", () => {
    expect(estaNoHorario(regra, TERCA_10H, "America/Rio_Branco")).toBe(false);
  });

  it("horário torto responde 'Não'; sem relógio também", () => {
    expect(estaNoHorario({ start: "18:00", end: "09:00", weekdays: [1] }, TERCA_10H, SP)).toBe(
      false,
    );
    expect(avaliarRegraNova(regra, undefined)).toBe(false);
  });

  it("no motor: o nó de condição sai por Sim/Não pela hora local", () => {
    const no = {
      id: "c",
      type: "condition",
      label: "Horário?",
      position: { x: 0, y: 0 },
      config: { combinator: "and", checks: [regra] },
    } as unknown as FlowNode;
    const edges: FlowEdge[] = [
      {
        id: "s",
        source: "c",
        target: "sim",
        priority: 0,
        condition: { type: "cond_result", value: true },
      },
      {
        id: "n",
        source: "c",
        target: "nao",
        priority: 1,
        condition: { type: "cond_result", value: false },
      },
    ];
    const em = (agora: Date) =>
      processNode({
        node: no,
        edges,
        enrollment: inscricao({ current_node_id: "c" }),
        lead: lead(),
        clock: () => agora,
      });
    expect(em(TERCA_10H)).toMatchObject({ kind: "advance", next_node_id: "sim" });
    expect(em(new Date("2026-11-15T13:00:00.000Z"))).toMatchObject({
      kind: "advance",
      next_node_id: "nao",
    });
  });
});

describe("publicação", () => {
  const grafo = (wait: Record<string, unknown>, extraEdges: unknown[] = []): FlowGraph =>
    flowGraphSchema.parse({
      nodes: [
        {
          id: "inicio",
          type: "trigger",
          label: "Início",
          position: { x: 0, y: 0 },
          config: {
            triggers: [{ kind: "lead_created" }],
            reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
          },
        },
        { id: "espera", type: "wait", label: "Espera", position: { x: 0, y: 1 }, config: wait },
        {
          id: "fim",
          type: "end",
          label: "Fim",
          position: { x: 0, y: 2 },
          config: { outcome: "converted" },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "inicio",
          target: "espera",
          priority: 0,
          condition: { type: "always" },
        },
        { id: "e2", source: "espera", target: "fim", priority: 0, condition: { type: "always" } },
        ...extraEdges,
      ],
    });
  const codigos = (
    g: FlowGraph,
    ctx: Parameters<typeof validateFlowForPublish>[1] = { surface: "automacao" },
  ) => {
    const v = validateFlowForPublish(g, ctx);
    return v.ok ? [] : v.errors.map((e) => e.code);
  };

  it("amanhã 09:00 publica na automação; no follow-up não", () => {
    const g = grafo({ mode: "until_time", when: "tomorrow", time: "09:00" });
    expect(codigos(g)).toEqual([]);
    expect(codigos(g, { surface: "followup" })).toContain("espera_so_na_automacao");
  });

  it("hora em branco, dias faltando e dia da semana faltando não publicam", () => {
    expect(codigos(grafo({ mode: "until_time", when: "tomorrow", time: "" }))).toContain(
      "hora_da_espera_invalida",
    );
    expect(codigos(grafo({ mode: "until_time", when: "in_days", time: "09:00" }))).toContain(
      "hora_da_espera_invalida",
    );
    expect(codigos(grafo({ mode: "until_time", when: "next_weekday", time: "09:00" }))).toContain(
      "hora_da_espera_invalida",
    );
  });

  it("data do campo: precisa do campo, e o campo precisa existir num funil", () => {
    const ok = { mode: "until_date_field", field_key: "visita", offset_days: 0, time: "09:00" };
    const semData = [
      {
        id: "e3",
        source: "espera",
        target: "fim",
        priority: 1,
        condition: { type: "branch", branch_id: "sem_data" },
      },
    ];
    expect(
      codigos(grafo(ok, semData), { surface: "automacao", camposDeData: new Set(["visita"]) }),
    ).toEqual([]);
    expect(
      codigos(grafo(ok, semData), { surface: "automacao", camposDeData: new Set(["outro"]) }),
    ).toContain("campo_de_data_inexistente");
    expect(codigos(grafo({ ...ok, field_key: "" }, semData))).toContain("campo_de_data_ausente");
  });

  it("'só no horário' torto não publica também na espera em segundos", () => {
    expect(
      codigos(
        grafo({
          mode: "delay",
          duration_s: 5,
          ate_o_horario: { start: "18:00", end: "09:00", weekdays: [1] },
        }),
      ),
    ).toContain("horario_da_espera_invalido");
  });

  describe("ciclo recorrente (espera → mensagem → volta à espera)", () => {
    const ciclo = (wait: Record<string, unknown>): FlowGraph =>
      flowGraphSchema.parse({
        nodes: [
          {
            id: "inicio",
            type: "trigger",
            label: "Início",
            position: { x: 0, y: 0 },
            config: {
              triggers: [{ kind: "lead_created" }],
              reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
            },
          },
          { id: "espera", type: "wait", label: "Espera", position: { x: 0, y: 1 }, config: wait },
          {
            id: "msg",
            type: "message",
            label: "Lembrete",
            position: { x: 0, y: 2 },
            config: { body: "Bom dia!" },
          },
          // O laço tem saída (a condição decide se volta): "espera → mensagem →
          // volta à espera" só é recusado pelo ciclo, não por falta de fim.
          {
            id: "rep",
            type: "condition",
            label: "No horário?",
            position: { x: 0, y: 3 },
            config: { combinator: "and", checks: [{ kind: "business_hours", ...COMERCIAL }] },
          },
          {
            id: "fim",
            type: "end",
            label: "Fim",
            position: { x: 0, y: 4 },
            config: { outcome: "converted" },
          },
        ],
        edges: [
          {
            id: "e1",
            source: "inicio",
            target: "espera",
            priority: 0,
            condition: { type: "always" },
          },
          { id: "e2", source: "espera", target: "msg", priority: 0, condition: { type: "always" } },
          { id: "e3", source: "msg", target: "rep", priority: 0, condition: { type: "always" } },
          {
            id: "e4",
            source: "rep",
            target: "espera",
            priority: 0,
            condition: { type: "cond_result", value: true },
          },
          {
            id: "e5",
            source: "rep",
            target: "fim",
            priority: 1,
            condition: { type: "cond_result", value: false },
          },
        ],
      });

    it("'até a próxima segunda, 09:00' → mensagem → volta à espera publica", () => {
      expect(
        codigos(ciclo({ mode: "until_time", when: "next_weekday", weekday: 1, time: "09:00" })),
      ).toEqual([]);
    });

    it("'amanhã' e 'daqui a N dias' também quebram o ciclo", () => {
      expect(codigos(ciclo({ mode: "until_time", when: "tomorrow", time: "09:00" }))).toEqual([]);
      expect(
        codigos(ciclo({ mode: "until_time", when: "in_days", days: 3, time: "09:00" })),
      ).toEqual([]);
    });

    it("'hoje, 09:00' (que pode já ter passado e seguir na hora) é recusado como ciclo sem espera", () => {
      expect(codigos(ciclo({ mode: "until_time", when: "today", time: "09:00" }))).toContain(
        "cycle_without_wait",
      );
    });

    it("'até a data de um campo' (vazia ou passada sai na hora) não quebra o ciclo", () => {
      expect(
        codigos(
          ciclo({ mode: "until_date_field", field_key: "visita", offset_days: 1, time: "09:00" }),
        ),
      ).toContain("cycle_without_wait");
    });

    it("a conta confere com o plano de tempo: no instante do horário, 'próxima segunda' vai a +7 dias e 'amanhã' nunca é hoje", () => {
      // Segunda 09/11/2026 09:00 em SP = 12:00Z. Acordou agora e voltou à espera.
      const acordou = new Date("2026-11-09T12:00:00.000Z");
      const proxima = instanteAteODia(
        { when: "next_weekday", weekday: 1, time: "09:00" },
        acordou,
        SP,
      );
      expect(proxima.getTime() - acordou.getTime()).toBe(7 * 86_400_000);
      const amanha = instanteAteODia({ when: "tomorrow", time: "09:00" }, acordou, SP);
      expect(amanha.getTime() - acordou.getTime()).toBe(86_400_000);
      const piso = (c: Parameters<typeof duracaoMinimaDaEspera>[0]) => duracaoMinimaDaEspera(c);
      expect(
        piso({ mode: "until_time", when: "next_weekday", weekday: 1, time: "09:00" }),
      ).toBeLessThanOrEqual(proxima.getTime() - acordou.getTime());
      expect(piso({ mode: "until_time", when: "tomorrow", time: "09:00" })).toBeLessThanOrEqual(
        amanha.getTime() - acordou.getTime(),
      );
    });

    it("o teto da data do campo cresce com o deslocamento para depois dela", () => {
      const base = { mode: "until_date_field", field_key: "visita", time: "09:00" } as const;
      expect(duracaoMaximaDaEspera({ ...base, offset_days: -30 })).toBe(7_776_000_000);
      expect(duracaoMaximaDaEspera({ ...base, offset_days: 3650 })).toBe(
        7_776_000_000 + 3650 * 86_400_000,
      );
    });
  });

  it("os grafos antigos seguem válidos byte a byte (nenhuma chave nova obrigatória)", () => {
    const antigo = { mode: "delay", duration_s: 30 };
    expect(waitConfigSchema.parse(antigo)).toEqual(antigo);
  });
});

describe("reatividade e textos", () => {
  it("as esperas novas são tempo puro: a mensagem do contato não as antecipa", () => {
    for (const wait_mode of ["delay", "until_time", "until_date_field"]) {
      expect(esperaDeTempoPuro({ lane: "automacao", status: "active", wait_mode })).toBe(true);
    }
    expect(esperaDeTempoPuro({ lane: "automacao", status: "active", wait_mode: "fixed" })).toBe(
      false,
    );
  });

  it("a execução diz 'Esperando até …' e o resumo diz 'até amanhã, 09:00'", () => {
    const no = espera({ mode: "until_time", when: "tomorrow", time: "09:00" });
    const resumo = resumoDoNo(no, "automacao");
    expect(resumo.resumo).toBe("espera até amanhã, 09:00");
    const linha = descreveEvento(
      {
        id: "x",
        node_id: "espera",
        event_type: "wait_started",
        payload: { next_eval_at: "2026-11-11T12:00:00.000Z" },
        created_at: "",
      },
      { espera: resumo },
      "pt-BR",
      "automacao",
    );
    expect(linha.titulo).toMatch(/^Esperando até /);
    expect(linha.titulo).toMatch(/11/);
  });

  it("terminar sem data (saída sem ligação) diz qual campo faltava", () => {
    const no = espera({
      mode: "until_date_field",
      field_key: "visita",
      offset_days: -1,
      time: "09:00",
    });
    const resumo = resumoDoNo(no, "automacao");
    const linha = descreveEvento(
      {
        id: "x",
        node_id: "espera",
        event_type: "flow_completed",
        payload: { outcome: null, cancel_reason: MOTIVO_SEM_DATA_NO_CAMPO },
        created_at: "",
      },
      { espera: resumo },
      "pt-BR",
      "automacao",
    );
    expect(linha.titulo).toBe("Automação concluída");
    expect(linha.detalhe).toBe("Terminou: não havia data futura no campo “visita”");
  });

  it("a saída 'Sem data' é contada por extenso", () => {
    const linha = descreveEvento(
      {
        id: "x",
        node_id: "espera",
        event_type: "node_advanced",
        payload: { next_node_id: "aviso", class: "sem_data" },
        created_at: "",
      },
      {},
      "pt-BR",
    );
    expect(linha.titulo).toBe("A data do campo estava vazia ou já tinha passado");
  });
});
