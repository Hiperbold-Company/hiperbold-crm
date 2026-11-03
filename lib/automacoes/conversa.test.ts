import { describe, expect, it } from "vitest";

import {
  flowGraphSchema,
  messageConfigSchema,
  nodeBranches,
  questionConfigSchema,
  waitConfigSchema,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "@/lib/followup/graph-schema";
import {
  decidirConversa,
  processNode,
  type EnrollmentEventRef,
  type EnrollmentRow,
} from "@/lib/followup/node-handlers";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import {
  chaveDaResposta,
  conferirRespostaDaPergunta,
  estadoDaEspera,
  pisoDaEspera,
} from "./conversa";
import { renderizar } from "./template-vars";

const AGORA = new Date("2026-11-03T12:00:00.000Z");
const clock = () => AGORA;
const pos = { x: 0, y: 0 };

const OPCOES = {
  kind: "buttons" as const,
  items: [
    { id: "moradia", label: "Moradia" },
    { id: "invest", label: "Investimento" },
  ],
};

function mensagem(config: Record<string, unknown>): FlowNode {
  return { id: "message-1", type: "message", label: "Mensagem", position: pos, config } as FlowNode;
}
function pergunta(config: Record<string, unknown> = {}): FlowNode {
  return {
    id: "question-2",
    type: "question",
    label: "Pergunta",
    position: pos,
    config: {
      question: "Seu e-mail?",
      save_to: { scope: "contact", key: "email" },
      validation: "email",
      timeout_ms: 3_600_000,
      retries: 1,
      ...config,
    },
  } as FlowNode;
}

function enrollment(): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "c-1",
    conversation_id: null,
    current_node_id: "message-1",
    status: "active",
    next_eval_at: AGORA.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 2,
    outcome: null,
    cancel_reason: null,
    started_at: AGORA.toISOString(),
    completed_at: null,
    updated_at: AGORA.toISOString(),
    lane: "automacao",
    vars: {},
  };
}

const aresta = (
  id: string,
  source: string,
  target: string,
  cond: FlowEdge["condition"],
): FlowEdge => ({
  id,
  source,
  target,
  priority: 0,
  condition: cond,
});

const EDGES_DA_MENSAGEM: FlowEdge[] = [
  aresta("a1", "message-1", "fim-moradia", { type: "branch", branch_id: "moradia" }),
  aresta("a2", "message-1", "fim-invest", { type: "branch", branch_id: "invest" }),
  aresta("a3", "message-1", "fim-sem", { type: "branch", branch_id: "no_reply" }),
  aresta("a4", "message-1", "fim-erro", { type: "branch", branch_id: "erro" }),
  aresta("a5", "message-1", "fim-invalida", { type: "always" }),
];

function entrada(node: FlowNode, extra: Record<string, unknown> = {}, edges = EDGES_DA_MENSAGEM) {
  return {
    node,
    edges,
    enrollment: enrollment(),
    lead: { lead_stage: null, tags: [], steps_taken: 2, last_outcome: null },
    clock,
    ...extra,
  };
}

const PRAZO = new Date(AGORA.getTime() + 600_000).toISOString();
const esperando = (novasTentativas = 0, prazo = PRAZO) => ({
  aguardando: true,
  prazo,
  novasTentativas,
});

describe("schemas dos blocos de conversa", () => {
  it("mensagem com opções exige o tempo de espera e ids únicos", () => {
    expect(messageConfigSchema.safeParse({ body: "Oi", options: OPCOES }).success).toBe(false);
    expect(
      messageConfigSchema.safeParse({ body: "Oi", options: OPCOES, reply_timeout_ms: 600_000 })
        .success,
    ).toBe(true);
    const repetida = {
      kind: "buttons",
      items: [
        { id: "a", label: "A" },
        { id: "a", label: "B" },
      ],
    };
    expect(
      messageConfigSchema.safeParse({ body: "Oi", options: repetida, reply_timeout_ms: 600_000 })
        .success,
    ).toBe(false);
  });
  it("opção não toma id do contrato, e botões são no máximo 3", () => {
    for (const id of ["erro", "invalida", "no_reply", "else"]) {
      const o = { kind: "buttons", items: [{ id, label: "X" }] };
      expect(
        messageConfigSchema.safeParse({ body: "Oi", options: o, reply_timeout_ms: 600_000 })
          .success,
        id,
      ).toBe(false);
    }
    const quatro = {
      kind: "buttons",
      items: ["a", "b", "c", "d"].map((id) => ({ id, label: id })),
    };
    expect(
      messageConfigSchema.safeParse({ body: "Oi", options: quatro, reply_timeout_ms: 600_000 })
        .success,
    ).toBe(false);
  });
  it("corpo com opções tem no máximo 1024 caracteres; sem opções, até 4000", () => {
    const longo = "x".repeat(1025);
    expect(
      messageConfigSchema.safeParse({ body: longo, options: OPCOES, reply_timeout_ms: 600_000 })
        .success,
    ).toBe(false);
    expect(messageConfigSchema.safeParse({ body: longo }).success).toBe(true);
  });
  it("tempo limite: mensagem de 1 min a 30 dias, pergunta até 7 dias", () => {
    expect(
      messageConfigSchema.safeParse({ body: "Oi", options: OPCOES, reply_timeout_ms: 59_000 })
        .success,
    ).toBe(false);
    expect(
      questionConfigSchema.safeParse({ ...pergunta().config, timeout_ms: 8 * 86_400_000 }).success,
    ).toBe(false);
    expect(questionConfigSchema.safeParse({ ...pergunta().config, retries: 6 }).success).toBe(
      false,
    );
    expect(
      questionConfigSchema.safeParse({
        ...pergunta().config,
        save_to: { scope: "var", path: "resposta.x" },
      }).success,
    ).toBe(false);
  });
  it("espera em segundos e até responder; o fixo mantém o piso de 5 min", () => {
    expect(waitConfigSchema.safeParse({ mode: "delay", duration_s: 1 }).success).toBe(true);
    expect(waitConfigSchema.safeParse({ mode: "delay", duration_s: 0 }).success).toBe(false);
    expect(waitConfigSchema.safeParse({ mode: "until_reply", timeout_ms: 60_000 }).success).toBe(
      true,
    );
    expect(
      waitConfigSchema.safeParse({ mode: "until_reply", timeout_ms: 31 * 86_400_000 }).success,
    ).toBe(false);
    expect(waitConfigSchema.safeParse({ mode: "fixed", duration_ms: 60_000 }).success).toBe(false);
  });
});

describe("ramos dos blocos de conversa", () => {
  it("mensagem com opções: uma por opção, Sem resposta, Erro e Resposta inválida (escape)", () => {
    const ramos = nodeBranches(
      mensagem({ body: "Oi", options: OPCOES, reply_timeout_ms: 600_000 }) as never,
    );
    expect(ramos.map((r) => [r.id, r.label])).toEqual([
      ["moradia", "Moradia"],
      ["invest", "Investimento"],
      ["no_reply", "Sem resposta"],
      ["erro", "Erro"],
      ["else", "Resposta inválida"],
    ]);
  });
  it("mensagem sem opções: Erro e Concluído; pergunta: Sem resposta, Resposta inválida, Erro, Respondeu", () => {
    expect(nodeBranches(mensagem({ body: "Oi" }) as never).map((r) => r.label)).toEqual([
      "Erro",
      "Concluído",
    ]);
    expect(nodeBranches(pergunta() as never).map((r) => r.label)).toEqual([
      "Sem resposta",
      "Resposta inválida",
      "Erro",
      "Respondeu",
    ]);
  });
  it("espera até responder: Sem resposta e Respondeu; em segundos: saída única", () => {
    const ate = {
      id: "w",
      type: "wait",
      label: "W",
      position: pos,
      config: { mode: "until_reply", timeout_ms: 60_000 },
    };
    expect(nodeBranches(ate as never).map((r) => r.label)).toEqual(["Sem resposta", "Respondeu"]);
    const seg = {
      id: "w",
      type: "wait",
      label: "W",
      position: pos,
      config: { mode: "delay", duration_s: 5 },
    };
    expect(nodeBranches(seg as never)).toHaveLength(1);
  });
});

describe("conferência da resposta da pergunta", () => {
  it.each([
    ["email", " Maria@Exemplo.com ", "maria@exemplo.com"],
    ["phone", "(35) 99148-5627", "+5535991485627"],
    ["number", "1.234,5", "1234.5"],
    ["date", "31/12/2026", "2026-12-31"],
    ["cpf", "529.982.247-25", "52998224725"],
    ["text", "  qualquer coisa ", "qualquer coisa"],
  ] as const)("%s aceita %j", (tipo, bruto, valor) => {
    expect(conferirRespostaDaPergunta(tipo, bruto)).toEqual({ ok: true, valor });
  });
  it.each([
    ["email", "maria@"],
    ["phone", "liga pra mim"],
    ["number", "dez"],
    ["date", "31/02/2026"],
    ["cpf", "529.982.247-24"],
    ["cpf", "meu cpf é 52998224725"],
    ["text", "   "],
  ] as const)("%s recusa %j", (tipo, bruto) => {
    expect(conferirRespostaDaPergunta(tipo, bruto)).toEqual({ ok: false });
  });
});

describe("estado da espera lido dos eventos", () => {
  const ev = (
    event_type: string,
    payload: Record<string, unknown> = {},
    node_id = "message-1",
  ): EnrollmentEventRef => ({
    node_id,
    idempotency_key: `${node_id}:${event_type}`,
    event_type,
    payload,
  });
  it("conta a estadia atual e para no node_advanced anterior", () => {
    const eventos = [
      ev("wait_started", { next_eval_at: "antigo" }),
      ev("node_advanced"),
      ev("node_advanced", {}, "outro"),
      ev("effect_done", { detalhes: [{ envio: "mensagem" }] }),
      ev("wait_started", { next_eval_at: "2026-11-03T12:10:00.000Z" }),
      ev("effect_done", { detalhes: [{ envio: "nova_tentativa" }] }),
      ev("wait_started", { next_eval_at: "2026-11-03T12:20:00.000Z" }),
    ];
    expect(estadoDaEspera(eventos, "message-1")).toEqual({
      aguardando: true,
      prazo: "2026-11-03T12:20:00.000Z",
      novasTentativas: 1,
    });
    expect(estadoDaEspera([ev("node_advanced", {}, "outro")], "message-1").aguardando).toBe(false);
  });
  it("o piso é o início da espera em curso", () => {
    expect(pisoDaEspera("2026-11-03T12:10:00.000Z", 600_000, "x")).toBe("2026-11-03T12:00:00.000Z");
    expect(pisoDaEspera(null, 600_000, "x")).toBe("x");
  });
});

describe("decisão do bloco de mensagem", () => {
  const comOpcoes = mensagem({
    body: "Qual?",
    options: OPCOES,
    reply_timeout_ms: 600_000,
    invalid_reply: { attempts: 1 },
  });

  it("entrada pede o envio; enviado, espera em waiting_reply até o prazo", () => {
    expect(decidirConversa(entrada(comOpcoes))).toEqual({
      kind: "effect",
      acao: { tipo: "enviar", envio: "mensagem" },
    });
    expect(decidirConversa(entrada(comOpcoes, { efeito: { ok: true } }))).toEqual({
      kind: "wait",
      next_eval_at: new Date(PRAZO),
      wake_status: "waiting_reply",
    });
  });
  it("envio falhou (janela, teto, sem conversa) sai por Erro com o motivo", () => {
    const r = decidirConversa(
      entrada(comOpcoes, { efeito: { ok: false, erro: "janela_fechada" } }),
    );
    expect(r).toMatchObject({ kind: "advance", next_node_id: "fim-erro" });
  });
  it("sem opções não espera: sai por Concluído", () => {
    const edges = [aresta("c", "message-1", "fim-ok", { type: "always" })];
    expect(
      decidirConversa(entrada(mensagem({ body: "Oi" }), { efeito: { ok: true } }, edges)),
    ).toMatchObject({
      kind: "advance",
      next_node_id: "fim-ok",
    });
  });
  it("resposta nativa (id) e número escolhem a opção, e a escolha é registrada antes de sair", () => {
    const nativa = entrada(comOpcoes, {
      espera: esperando(),
      respostas: [{ texto: "Investimento", replyId: "invest" }],
    });
    expect(decidirConversa(nativa)).toEqual({
      kind: "effect",
      acao: { tipo: "registrar_resposta", valor: "Investimento", opcao_id: "invest" },
    });
    expect(decidirConversa({ ...nativa, efeito: { ok: true } })).toMatchObject({
      kind: "advance",
      next_node_id: "fim-invest",
    });
    const numero = entrada(comOpcoes, {
      espera: esperando(),
      respostas: [
        { texto: "oi", replyId: null },
        { texto: "1", replyId: null },
      ],
    });
    expect(decidirConversa(numero)).toMatchObject({ acao: { opcao_id: "moradia" } });
  });
  it("resposta inválida: nova tentativa enquanto houver, depois Resposta inválida", () => {
    const invalida = { respostas: [{ texto: "talvez", replyId: null }] };
    expect(decidirConversa(entrada(comOpcoes, { espera: esperando(0), ...invalida }))).toEqual({
      kind: "effect",
      acao: { tipo: "enviar", envio: "nova_tentativa" },
    });
    expect(
      decidirConversa(
        entrada(comOpcoes, { espera: esperando(0), ...invalida, efeito: { ok: true } }),
      ),
    ).toMatchObject({
      kind: "wait",
      wake_status: "waiting_reply",
    });
    expect(
      decidirConversa(entrada(comOpcoes, { espera: esperando(1), ...invalida })),
    ).toMatchObject({
      kind: "advance",
      next_node_id: "fim-invalida",
    });
  });
  it("sem resposta: espera com o MESMO prazo; vencido, Sem resposta", () => {
    expect(decidirConversa(entrada(comOpcoes, { espera: esperando(), respostas: [] }))).toEqual({
      kind: "wait",
      next_eval_at: new Date(PRAZO),
      wake_status: "waiting_reply",
    });
    const vencido = new Date(AGORA.getTime() - 1).toISOString();
    expect(
      decidirConversa(entrada(comOpcoes, { espera: esperando(0, vencido), respostas: [] })),
    ).toMatchObject({
      kind: "advance",
      next_node_id: "fim-sem",
    });
  });
  it("ramo sem aresta (e sem escape) termina a execução em vez de travar", () => {
    const edges = [
      aresta("a1", "message-1", "fim-moradia", { type: "branch", branch_id: "moradia" }),
    ];
    const r = decidirConversa(
      entrada(
        comOpcoes,
        { espera: esperando(1), respostas: [{ texto: "?", replyId: null }] },
        edges,
      ),
    );
    expect(r.kind).toBe("complete");
  });
});

describe("decisão da pergunta e da espera", () => {
  const edges = [
    aresta("q1", "question-2", "ok", { type: "always" }),
    aresta("q2", "question-2", "sem", { type: "branch", branch_id: "no_reply" }),
    aresta("q3", "question-2", "inv", { type: "branch", branch_id: "invalida" }),
  ];
  it("resposta válida é registrada já normalizada e sai por Respondeu", () => {
    const e = entrada(
      pergunta(),
      { espera: esperando(), respostas: [{ texto: "Ana@X.com", replyId: null }] },
      edges,
    );
    expect(decidirConversa(e)).toEqual({
      kind: "effect",
      acao: { tipo: "registrar_resposta", valor: "ana@x.com" },
    });
    expect(decidirConversa({ ...e, efeito: { ok: true } })).toMatchObject({
      kind: "advance",
      next_node_id: "ok",
    });
  });
  it("tentativas esgotadas saem por Resposta inválida", () => {
    const e = entrada(
      pergunta({ retries: 0 }),
      { espera: esperando(), respostas: [{ texto: "não sei", replyId: null }] },
      edges,
    );
    expect(decidirConversa(e)).toMatchObject({ kind: "advance", next_node_id: "inv" });
  });
  it("tempo esgotado envia o aviso (se houver) e sai por Sem resposta", () => {
    const vencido = new Date(AGORA.getTime() - 1).toISOString();
    const e = entrada(
      pergunta({ timeout_message: "Tudo bem, fica pra depois." }),
      { espera: esperando(0, vencido), respostas: [] },
      edges,
    );
    expect(decidirConversa(e)).toEqual({
      kind: "effect",
      acao: { tipo: "enviar", envio: "tempo_esgotado" },
    });
    expect(decidirConversa({ ...e, efeito: { ok: false, erro: "envio_falhou" } })).toMatchObject({
      next_node_id: "sem",
    });
  });
  it("espera em segundos: estaciona por N s e depois segue", () => {
    const no = {
      id: "w",
      type: "wait",
      label: "W",
      position: pos,
      config: { mode: "delay", duration_s: 5 },
    } as FlowNode;
    const ed = [aresta("w1", "w", "prox", { type: "always" })];
    expect(processNode(entrada(no, {}, ed))).toEqual({
      kind: "wait",
      next_eval_at: new Date(AGORA.getTime() + 5000),
    });
    expect(processNode(entrada(no, { waitElapsed: true }, ed))).toMatchObject({
      kind: "advance",
      next_node_id: "prox",
    });
  });
  it("até responder: qualquer mensagem é resposta e não envia nada", () => {
    const no = {
      id: "w",
      type: "wait",
      label: "W",
      position: pos,
      config: { mode: "until_reply", timeout_ms: 600_000 },
    } as FlowNode;
    const ed = [
      aresta("w1", "w", "resp", { type: "always" }),
      aresta("w2", "w", "sem", { type: "branch", branch_id: "no_reply" }),
    ];
    expect(processNode(entrada(no, {}, ed))).toMatchObject({
      kind: "wait",
      wake_status: "waiting_reply",
    });
    const r = processNode(
      entrada(no, { espera: esperando(), respostas: [{ texto: "", replyId: null }] }, ed),
    );
    expect(r).toEqual({ kind: "effect", acao: { tipo: "registrar_resposta", valor: "" } });
  });
});

describe("variáveis e publish", () => {
  it("a resposta fica em {{resposta.<chave do nó>}}", () => {
    expect(chaveDaResposta("question-2")).toBe("question_2");
    const texto = renderizar(
      "Anotado: {{resposta.question_2}}",
      {
        contato: null,
        negocio: null,
        negocios: [],
        vars: { resposta: { question_2: "ana@x.com" } },
      },
      AGORA,
    );
    expect(texto).toBe("Anotado: ana@x.com");
  });

  function grafo(nodes: unknown[], edges: unknown[]): FlowGraph {
    return flowGraphSchema.parse({ nodes, edges });
  }
  const gatilho = {
    id: "t",
    type: "trigger",
    label: "Início",
    position: pos,
    config: {
      triggers: [{ kind: "manual" }],
      reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
    },
  };
  const fim = (id: string) => ({
    id,
    type: "end",
    label: "Fim",
    position: pos,
    config: { outcome: "converted" },
  });

  it("toda opção precisa de caminho", () => {
    const g = grafo(
      [gatilho, mensagem({ body: "Qual?", options: OPCOES, reply_timeout_ms: 600_000 }), fim("f1")],
      [
        aresta("e0", "t", "message-1", { type: "always" }),
        aresta("e1", "message-1", "f1", { type: "branch", branch_id: "moradia" }),
        aresta("e2", "message-1", "f1", { type: "always" }),
      ],
    );
    const r = validateFlowForPublish(g, { surface: "automacao" });
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.errors.map((e) => [e.code, e.branch_id])).toContainEqual([
      "missing_branch_edge",
      "invest",
    ]);
    const ligado = grafo(
      [gatilho, mensagem({ body: "Qual?", options: OPCOES, reply_timeout_ms: 600_000 }), fim("f1")],
      [
        aresta("e0", "t", "message-1", { type: "always" }),
        aresta("e1", "message-1", "f1", { type: "branch", branch_id: "moradia" }),
        aresta("e3", "message-1", "f1", { type: "branch", branch_id: "invest" }),
      ],
    );
    expect(validateFlowForPublish(ligado, { surface: "automacao" })).toEqual({ ok: true });
  });
  it("pergunta não grava em campo só leitura, e os blocos não rodam no follow-up", () => {
    const g = grafo(
      [
        gatilho,
        pergunta({ save_to: { scope: "contact", key: "phone_number" }, validation: "phone" }),
        fim("f1"),
      ],
      [
        aresta("e0", "t", "question-2", { type: "always" }),
        aresta("e1", "question-2", "f1", { type: "always" }),
      ],
    );
    const r = validateFlowForPublish(g, { surface: "automacao" });
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toContain("campo_so_leitura");
    const seg = {
      id: "w",
      type: "wait",
      label: "W",
      position: pos,
      config: { mode: "delay", duration_s: 5 },
    };
    const follow = grafo(
      [{ ...gatilho, config: {} }, seg, fim("f1")],
      [aresta("e0", "t", "w", { type: "always" }), aresta("e1", "w", "f1", { type: "always" })],
    );
    const rf = validateFlowForPublish(follow, { surface: "followup" });
    expect(rf.ok ? [] : rf.errors.map((e) => e.code)).toContain("espera_so_na_automacao");
  });
});
