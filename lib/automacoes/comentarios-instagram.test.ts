/**
 * Comentários do Instagram nas automações: o gatilho `instagram_comment`, o
 * contato do comentarista, os três blocos (privada, pública, confere se segue)
 * com cada saída, a ordem privada → pública no publish, o replay que não repete
 * a privada e o histórico sem o texto do comentário.
 *
 * O canal é MOCKADO no ponto de troca (`./canal-de-comentarios`), nunca o código
 * da automação: o executor, as decisões e o motor rodam os de produção.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./canal-de-comentarios", async (original) => ({
  ...(await original<typeof import("./canal-de-comentarios")>()),
  pedirRespostaPrivada: vi.fn(),
  responderNoComentario: vi.fn(),
  conferirSeSegue: vi.fn(),
}));

import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  avancarEnrollmentAtivo,
  type AdminClient,
  type PedidoDeEfeito,
  type TickDeps,
} from "@/lib/followup/engine";
import { descreveEvento } from "@/lib/followup/eventos-legiveis";
import {
  flowGraphSchema,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "@/lib/followup/node-handlers";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import * as canal from "./canal-de-comentarios";
import { comentarioDoInstagramNoPlano, grafoUsaComentarioDoInstagram } from "./comentario-no-plano";
import { criarExecutorDeEfeitos } from "./efeitos";
import type { FatosDaAutomacao } from "./fatos";
import { casaGatilho, fatosDoEvento, varsDoGatilho, type FatoDeComentario } from "./gatilhos";
import { aplicarGatilhosDeAutomacao, type GatilhosDb } from "./gatilhos.handler";
import {
  automacaoTriggerSchema,
  type AutomacaoTrigger,
  type AutomacaoTriggerConfig,
} from "./schemas";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OUTRA_ORG = "00000000-0000-4000-8000-0000000000b2";
const SESSAO = "20000000-0000-4000-8000-000000000001";
const OUTRA_SESSAO = "20000000-0000-4000-8000-000000000002";
const CONTATO = "30000000-0000-4000-8000-000000000001";
const AGORA = new Date("2026-11-03T15:00:00Z");
const TEXTO_DO_COMENTARIO = "QUERO o e-book, por favor!";

const privada = vi.mocked(canal.pedirRespostaPrivada);
const publica = vi.mocked(canal.responderNoComentario);
const segue = vi.mocked(canal.conferirSeSegue);

beforeEach(() => {
  privada.mockReset();
  publica.mockReset();
  segue.mockReset();
});

function evento(
  over: Partial<Record<string, unknown>> = {},
  row: Partial<EventRow> = {},
): EventRow {
  return {
    id: "ev-1",
    organization_id: ORG,
    event_type: "instagram.comentario_recebido",
    entity_kind: "instagram_comment",
    entity_id: "40000000-0000-4000-8000-000000000001",
    payload: {
      organization_id: ORG,
      channel_session_id: SESSAO,
      comment_id: "1789001",
      media_id: "1801234",
      media_product_type: "REELS",
      autor_id: "6543210",
      autor_usuario: "maria.silva",
      texto: TEXTO_DO_COMENTARIO,
      criado_na_meta_em: AGORA.toISOString(),
      ...over,
    },
    metadata: {},
    ...row,
  } as unknown as EventRow;
}

function gatilho(
  over: Partial<Extract<AutomacaoTrigger, { kind: "instagram_comment" }>> = {},
): AutomacaoTrigger {
  return automacaoTriggerSchema.parse({
    kind: "instagram_comment",
    match: "any",
    keywords: [],
    ...over,
  });
}

function fato(row = evento()): FatoDeComentario {
  const [f] = fatosDoEvento(row);
  return f as FatoDeComentario;
}

// ---------------------------------------------------------------------------
// Gatilho: o que dispara e o que não
// ---------------------------------------------------------------------------

describe("gatilho Comentário no Instagram", () => {
  it("lê o evento do canal e guarda o texto só em vars", () => {
    const f = fato();
    expect(f).toMatchObject({
      tipo: "instagram_comment",
      comment_id: "1789001",
      autor_usuario: "maria.silva",
    });
    expect(varsDoGatilho(f, "ev-1")).toEqual({
      gatilho: {
        tipo: "instagram_comment",
        comment_id: "1789001",
        media_id: "1801234",
        channel_session_id: SESSAO,
        autor_id: "6543210",
        autor_usuario: "maria.silva",
        texto: TEXTO_DO_COMENTARIO,
        event_id: "ev-1",
      },
    });
  });

  it("evento de outra entidade, de payload de outra organização ou sem comentário não vira fato", () => {
    expect(fatosDoEvento(evento({}, { entity_kind: "message" }))).toEqual([]);
    expect(fatosDoEvento(evento({ organization_id: OUTRA_ORG }))).toEqual([]);
    expect(fatosDoEvento(evento({ comment_id: null }))).toEqual([]);
    expect(fatosDoEvento(evento({ channel_session_id: "nao-uuid" }))).toEqual([]);
  });

  it("dispara e não dispara por conta", () => {
    expect(casaGatilho(gatilho(), fato(), false)).toBe(true);
    expect(casaGatilho(gatilho({ channel_session_ids: [SESSAO] }), fato(), false)).toBe(true);
    expect(casaGatilho(gatilho({ channel_session_ids: [OUTRA_SESSAO] }), fato(), false)).toBe(
      false,
    );
  });

  it("dispara e não dispara por post (sem post no aviso, só casa gatilho sem lista)", () => {
    expect(casaGatilho(gatilho({ media_ids: ["1801234"] }), fato(), false)).toBe(true);
    expect(casaGatilho(gatilho({ media_ids: ["999"] }), fato(), false)).toBe(false);
    const semPost = fato(evento({ media_id: null }));
    expect(casaGatilho(gatilho(), semPost, false)).toBe(true);
    expect(casaGatilho(gatilho({ media_ids: ["1801234"] }), semPost, false)).toBe(false);
  });

  it("palavra-chave: qualquer uma, sem acento e maiúsculas, palavra inteira", () => {
    const g = gatilho({ match: "contains", keywords: ["eu quero", "ebook"] });
    expect(casaGatilho(gatilho({ match: "contains", keywords: ["quero"] }), fato(), false)).toBe(
      true,
    );
    expect(casaGatilho(gatilho({ match: "contains", keywords: ["QUÊRO"] }), fato(), false)).toBe(
      true,
    );
    expect(casaGatilho(gatilho({ match: "contains", keywords: ["quer"] }), fato(), false)).toBe(
      false,
    );
    expect(casaGatilho(g, fato(evento({ texto: "Eu QUERO!" })), false)).toBe(true);
    expect(casaGatilho(g, fato(evento({ texto: "lindo post" })), false)).toBe(false);
  });

  it("o schema recusa post que não é id e contém sem palavra", () => {
    expect(
      automacaoTriggerSchema.safeParse({
        kind: "instagram_comment",
        match: "contains",
        keywords: [],
      }).success,
    ).toBe(false);
    expect(
      automacaoTriggerSchema.safeParse({
        kind: "instagram_comment",
        match: "any",
        keywords: [],
        media_ids: ["https://www.instagram.com/p/Cx1/"],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler: própria conta, contato existente / criado / não criado
// ---------------------------------------------------------------------------

function config(...triggers: AutomacaoTrigger[]): AutomacaoTriggerConfig {
  return { triggers, reentry: { policy: "skip_if_running", cooldown_minutes: 0 } };
}

function db(cfg: AutomacaoTriggerConfig, over: Partial<GatilhosDb> = {}) {
  const iniciadas: Array<Parameters<GatilhosDb["iniciar"]>[0]> = [];
  const criados: Array<Parameters<GatilhosDb["criarContatoDoComentarista"]>[1]> = [];
  const nao = async () => {
    throw new Error("não deveria ser chamado");
  };
  const fake: GatilhosDb = {
    automacoesAtivas: async () => [{ id: "ptr-1", active_version_id: "v1" }],
    gatilhosDaVersao: async () => cfg,
    contatoDoNegocio: nao,
    contatoDoAgendamento: nao,
    contatoDaConversa: nao,
    conversaDeGrupo: nao,
    mensagemDaConversa: nao,
    respostaAAutomacaoNaConversa: nao,
    primeiraMensagemDaConversa: nao,
    humanoNaConversa: nao,
    fonteDeCaptacaoDaOrg: nao,
    identidadeDoComentarista: async (_o, _s, autor) => ({
      identidade: `instagram:178400:${autor}`,
      propriaConta: autor === "178400",
    }),
    contatoPelaIdentidade: async () => null,
    criarContatoDoComentarista: async (_o, input) => {
      criados.push(input);
      return CONTATO;
    },
    iniciar: async (input) => {
      iniciadas.push(input);
      return { resultado: "iniciada", enrollment_id: "enr-1" };
    },
    modoLeitura: async () => false,
    comentarioDoInstagramNoPlano: async () => true,
    ...over,
  };
  return { fake, iniciadas, criados };
}

describe("handler: contato do comentarista", () => {
  it("contato existente pela identidade social: inicia com ele, sem criar", async () => {
    const d = db(config(gatilho()), {
      contatoPelaIdentidade: async (_o, id) => (id === "instagram:178400:6543210" ? CONTATO : null),
    });
    const r = await aplicarGatilhosDeAutomacao(d.fake, evento());
    expect(r.iniciadas).toBe(1);
    expect(d.criados).toHaveLength(0);
    expect(d.iniciadas[0]).toMatchObject({
      organizationId: ORG,
      contactId: CONTATO,
      originEventId: "ev-1",
    });
  });

  it("sem contato e create_contact ausente: cria com @usuario e a identidade do Direct", async () => {
    const d = db(config(gatilho()));
    const r = await aplicarGatilhosDeAutomacao(d.fake, evento());
    expect(r.iniciadas).toBe(1);
    expect(d.criados).toEqual([
      {
        identidade: "instagram:178400:6543210",
        usuario: "maria.silva",
        pointerId: "ptr-1",
        requestId: "automacao:ptr-1:gatilho:ev-1",
      },
    ]);
  });

  it("sem contato e create_contact desligado: não cria e não inicia", async () => {
    const d = db(config(gatilho({ create_contact: false })));
    const r = await aplicarGatilhosDeAutomacao(d.fake, evento());
    expect(r).toMatchObject({ iniciadas: 0, ignoradas: 1 });
    expect(d.criados).toHaveLength(0);
    expect(d.iniciadas).toHaveLength(0);
  });

  it("comentário da própria conta não dispara", async () => {
    const d = db(config(gatilho()));
    const r = await aplicarGatilhosDeAutomacao(d.fake, evento({ autor_id: "178400" }));
    expect(r.iniciadas).toBe(0);
    expect(d.iniciadas).toHaveLength(0);
  });

  it("sessão que não é desta organização (ou não é Instagram) não dispara", async () => {
    const d = db(config(gatilho()), { identidadeDoComentarista: async () => null });
    expect((await aplicarGatilhosDeAutomacao(d.fake, evento())).iniciadas).toBe(0);
  });

  it("gatilho de outra conta não dispara nem cria contato", async () => {
    const d = db(config(gatilho({ channel_session_ids: [OUTRA_SESSAO] })));
    expect((await aplicarGatilhosDeAutomacao(d.fake, evento())).iniciadas).toBe(0);
    expect(d.criados).toHaveLength(0);
  });

  it("evento causado por regra antiga não dispara", async () => {
    const d = db(config(gatilho()));
    const r = await aplicarGatilhosDeAutomacao(
      d.fake,
      evento({}, { metadata: { request_id: "rule:x" } }),
    );
    expect(r.iniciadas).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Blocos: cada saída
// ---------------------------------------------------------------------------

const GATILHO_VARS = varsDoGatilho(fato(), "ev-1");
const FATOS = {
  contato: null,
  negocio: null,
  negocios: [],
  vars: GATILHO_VARS,
} as unknown as FatosDaAutomacao;

function no(type: FlowNode["type"], config: Record<string, unknown>): FlowNode {
  return { id: "ig-1", type, label: "Bloco", position: { x: 0, y: 0 }, config } as FlowNode;
}

function pedido(node: FlowNode, fatos: FatosDaAutomacao | null = FATOS): PedidoDeEfeito {
  return {
    enrollment: {
      id: "enr-1",
      pointer_id: "ptr-1",
      organization_id: ORG,
      contact_id: CONTATO,
    } as EnrollmentRow,
    node,
    fatos,
    chave: "ig-1:2",
  };
}

const executor = criarExecutorDeEfeitos({} as SupabaseClient, {
  clock: () => AGORA,
  podeProduzir: async () => true,
});

describe("Responder em privado", () => {
  const node = no("instagram_private_reply", { text: "Oi, @{{gatilho.autor_usuario}}!" });

  it("Enviada: pede ao canal com o comentário do gatilho e o texto renderizado", async () => {
    privada.mockResolvedValue({ status: "na_fila" });
    const r = await executor.executar(pedido(node));
    expect(r.desfecho).toEqual({ ok: true });
    expect(privada).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      commentId: "1789001",
      texto: "Oi, @maria.silva!",
      pedidoPor: "automacao:ptr-1:enr-1:ig-1:2",
    });
  });

  it("Já respondido, Prazo de 7 dias vencido e Erro", async () => {
    privada.mockResolvedValueOnce({ status: "ja_pedida" });
    expect((await executor.executar(pedido(node))).desfecho).toEqual({
      ok: true,
      saida: "ja_respondido",
    });
    privada.mockResolvedValueOnce({ status: "expirada" });
    expect((await executor.executar(pedido(node))).desfecho).toEqual({
      ok: true,
      saida: "prazo_vencido",
    });
    privada.mockResolvedValueOnce({ status: "nao_encontrado" });
    expect((await executor.executar(pedido(node))).desfecho).toEqual({
      ok: false,
      erro: "comentario_nao_encontrado",
    });
  });

  it("sem comentário no gatilho, sai por Erro sem chamar o canal", async () => {
    const r = await executor.executar(pedido(node, { ...FATOS, vars: {} }));
    expect(r.desfecho).toEqual({ ok: false, erro: "sem_comentario" });
    expect(privada).not.toHaveBeenCalled();
  });

  it("texto recusado pelo canal ou longo demais: Erro texto_invalido", async () => {
    privada.mockRejectedValueOnce(new Error(canal.ERRO_TEXTO_INVALIDO));
    expect((await executor.executar(pedido(node))).desfecho).toEqual({
      ok: false,
      erro: "texto_invalido",
    });
    const longo = no("instagram_private_reply", {
      text: "{{gatilho.texto}}".padEnd(990, "x") + "ééééééé",
    });
    expect((await executor.executar(pedido(longo))).desfecho).toEqual({
      ok: false,
      erro: "texto_invalido",
    });
  });
});

describe("Responder no comentário", () => {
  const node = no("instagram_public_reply", { text: "Te chamei no Direct!" });
  it("Enviada, Já respondido e Erro", async () => {
    publica.mockResolvedValueOnce({ status: "na_fila" });
    expect((await executor.executar(pedido(node))).desfecho).toEqual({ ok: true });
    publica.mockResolvedValueOnce({ status: "ja_pedida" });
    expect((await executor.executar(pedido(node))).desfecho).toEqual({
      ok: true,
      saida: "ja_respondido",
    });
    publica.mockResolvedValueOnce({ status: "nao_encontrado" });
    expect((await executor.executar(pedido(node))).desfecho).toEqual({
      ok: false,
      erro: "comentario_nao_encontrado",
    });
  });
});

describe("Confere se segue", () => {
  const node = no("instagram_check_follow", {});
  it("Segue, Não segue e Não deu para saber, com a conta e o autor do gatilho", async () => {
    segue.mockResolvedValueOnce({ segue: true });
    expect((await executor.executar(pedido(node))).desfecho).toEqual({ ok: true, saida: "segue" });
    expect(segue).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      channelSessionId: SESSAO,
      autorId: "6543210",
    });
    segue.mockResolvedValueOnce({ segue: false });
    expect((await executor.executar(pedido(node))).desfecho).toEqual({
      ok: true,
      saida: "nao_segue",
    });
    segue.mockResolvedValueOnce({ segue: null });
    expect((await executor.executar(pedido(node))).desfecho).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Publish: gatilho e ordem privada → pública
// ---------------------------------------------------------------------------

const pos = { x: 0, y: 0 };
const INICIO = (
  triggers: unknown[] = [{ kind: "instagram_comment", match: "any", keywords: [] }],
) => ({
  id: "t",
  type: "trigger",
  label: "Início",
  position: pos,
  config: { triggers, reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
});
const PRIV = {
  id: "priv",
  type: "instagram_private_reply",
  label: "Privada",
  position: pos,
  config: { text: "Oi" },
};
const PUB = {
  id: "pub",
  type: "instagram_public_reply",
  label: "Pública",
  position: pos,
  config: { text: "Te chamei" },
};
const FIM = {
  id: "fim",
  type: "end",
  label: "Fim",
  position: pos,
  config: { outcome: "converted" },
};
const aresta = (id: string, source: string, target: string): Record<string, unknown> => ({
  id,
  source,
  target,
  condition: { type: "always" },
});

function grafo(nodes: unknown[], edges: unknown[]): FlowGraph {
  return flowGraphSchema.parse({ nodes, edges });
}

function codigos(g: FlowGraph): string[] {
  const r = validateFlowForPublish(g, { surface: "automacao" });
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe("publish dos blocos do Instagram", () => {
  it("privada antes da pública passa", () => {
    const g = grafo(
      [INICIO(), PRIV, PUB, FIM],
      [aresta("a", "t", "priv"), aresta("b", "priv", "pub"), aresta("c", "pub", "fim")],
    );
    expect(codigos(g)).not.toContain("instagram_publica_antes_da_privada");
    expect(codigos(g)).not.toContain("instagram_sem_gatilho_de_comentario");
  });

  it("pública antes da privada no mesmo caminho é recusada com mensagem legível", () => {
    const g = grafo(
      [INICIO(), PRIV, PUB, FIM],
      [aresta("a", "t", "pub"), aresta("b", "pub", "priv"), aresta("c", "priv", "fim")],
    );
    const r = validateFlowForPublish(g, { surface: "automacao" });
    expect(r.ok).toBe(false);
    const erro = r.ok
      ? null
      : r.errors.find((e) => e.code === "instagram_publica_antes_da_privada");
    expect(erro?.node_id).toBe("pub");
    expect(erro?.message).toContain("Ponha a resposta privada antes da pública");
  });

  it("blocos do Instagram com gatilho que não é comentário são recusados", () => {
    const g = grafo(
      [INICIO([{ kind: "manual" }]), PRIV, FIM],
      [aresta("a", "t", "priv"), aresta("b", "priv", "fim")],
    );
    expect(codigos(g)).toContain("instagram_sem_gatilho_de_comentario");
  });
});

// ---------------------------------------------------------------------------
// Motor: as saídas pelo grafo e o replay que não repete a privada
// ---------------------------------------------------------------------------

function montar(g: FlowGraph) {
  const agora = AGORA;
  const eventos: EnrollmentEventRef[] = [];
  const inicial: EnrollmentRow = {
    id: "enr-1",
    organization_id: ORG,
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: CONTATO,
    conversation_id: null,
    current_node_id: "priv",
    status: "active",
    next_eval_at: agora.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 1,
    outcome: null,
    cancel_reason: null,
    started_at: agora.toISOString(),
    completed_at: null,
    updated_at: agora.toISOString(),
    lane: "automacao",
    vars: GATILHO_VARS,
  } as EnrollmentRow;
  let row = inicial;
  const db = {
    claimDueEnrollments: async () => [],
    loadFlowGraph: async () => g,
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadEnrollmentEvents: async () => eventos.map((e) => ({ ...e })),
    loadLastInboundBody: async () => null,
    insertEnrollmentEvent: async (e: EnrollmentEventRef & { idempotency_key: string }) => {
      if (eventos.some((x) => x.idempotency_key === e.idempotency_key)) return { inserted: false };
      eventos.push({
        node_id: e.node_id,
        idempotency_key: e.idempotency_key,
        event_type: e.event_type,
        payload: e.payload,
      });
      return { inserted: true };
    },
    updateEnrollment: async (_id: string, _org: string, patch: Partial<EnrollmentRow>) => {
      row = { ...row, ...patch } as EnrollmentRow;
    },
    loadFlowPointerName: async () => "Automação",
    insertDeadInboxItem: async () => {},
    persistirRespostaFollowup: async () => {},
    loadFatosDaAutomacao: async (_o: string, _c: string, vars: Record<string, unknown>) => ({
      contato: null,
      negocio: null,
      negocios: [],
      vars,
    }),
  } as unknown as AdminClient;
  const deps: TickDeps = { db, clock: () => agora, enqueueJob: async () => {}, efeitos: executor };
  return {
    eventos,
    get row() {
      return row;
    },
    tick: () => avancarEnrollmentAtivo(deps, row),
    /** O tick caiu depois do efeito e antes de avançar: a execução volta ao mesmo passo. */
    voltar: () => {
      row = inicial;
    },
  };
}

const GRAFO_MOTOR = grafo(
  [
    INICIO(),
    PRIV,
    { ...FIM, id: "fim-enviada", config: { outcome: "converted" } },
    { ...FIM, id: "fim-ja", config: { outcome: "custom", note: "ja" } },
    { ...FIM, id: "fim-prazo", config: { outcome: "custom", note: "prazo" } },
  ],
  [
    aresta("a", "t", "priv"),
    aresta("b", "priv", "fim-enviada"),
    {
      id: "c",
      source: "priv",
      target: "fim-ja",
      condition: { type: "branch", branch_id: "ja_respondido" },
    },
    {
      id: "d",
      source: "priv",
      target: "fim-prazo",
      condition: { type: "branch", branch_id: "prazo_vencido" },
    },
  ] as FlowEdge[],
);

describe("blocos do Instagram no motor", () => {
  it("cada desfecho segue pela saída dele", async () => {
    for (const [status, fim] of [
      ["na_fila", "fim-enviada"],
      ["ja_pedida", "fim-ja"],
      ["expirada", "fim-prazo"],
    ] as const) {
      privada.mockReset();
      privada.mockResolvedValue({ status });
      const m = montar(GRAFO_MOTOR);
      await m.tick();
      expect(
        m.eventos.some((e) => e.node_id === fim),
        status,
      ).toBe(true);
    }
  });

  it("replay do mesmo passo não pede a resposta privada de novo e segue o mesmo caminho", async () => {
    privada.mockResolvedValue({ status: "na_fila" });
    const m = montar(GRAFO_MOTOR);
    await m.tick();
    expect(privada).toHaveBeenCalledTimes(1);
    m.voltar();
    await m.tick();
    expect(privada).toHaveBeenCalledTimes(1);
    expect(m.eventos.filter((e) => e.event_type === "effect_done")).toHaveLength(1);
  });

  it("os eventos da execução não guardam o texto do comentário nem o da resposta", async () => {
    privada.mockResolvedValue({ status: "na_fila" });
    const m = montar(GRAFO_MOTOR);
    await m.tick();
    const tudo = JSON.stringify(m.eventos);
    expect(tudo).not.toContain(TEXTO_DO_COMENTARIO);
    expect(tudo).not.toContain("maria.silva");
    expect(m.row.vars).toMatchObject({ gatilho: { texto: TEXTO_DO_COMENTARIO } });
  });
});

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------

describe("histórico legível", () => {
  const ev = (event_type: string, payload: Record<string, unknown>) =>
    descreveEvento(
      { id: "x", node_id: null, event_type, payload, created_at: AGORA.toISOString() },
      {},
      "pt-BR",
      "automacao",
    );

  it("frases de cada desfecho", () => {
    expect(ev("automacao_iniciada", { gatilho: "instagram_comment" }).detalhe).toBe(
      "começou: comentário no Instagram",
    );
    const d = (tipo: string, resultado: string) =>
      ev("effect_done", { detalhes: [{ tipo, ok: true, resultado }] }).detalhe;
    expect(d("instagram_private_reply", "na_fila")).toBe("Resposta privada enviada");
    expect(d("instagram_private_reply", "ja_pedida")).toBe(
      "Resposta privada já tinha sido enviada para este comentário",
    );
    expect(d("instagram_private_reply", "expirada")).toBe(
      "Resposta privada não enviada: prazo de 7 dias vencido",
    );
    expect(d("instagram_public_reply", "na_fila")).toBe("Resposta pública enviada");
    expect(d("instagram_check_follow", "segue")).toBe("Segue o perfil");
    expect(d("instagram_check_follow", "nao_segue")).toBe("Não segue o perfil");
    expect(d("instagram_check_follow", "indefinido")).toBe("Não deu para saber se segue o perfil");
    expect(
      ev("effect_failed", {
        desfecho: { ok: false, erro: "comentario_nao_encontrado" },
        detalhes: [
          { tipo: "instagram_private_reply", ok: false, erro: "comentario_nao_encontrado" },
        ],
      }).detalhe,
    ).toContain("Resposta privada: o comentário não foi encontrado");
  });
});

// ---------------------------------------------------------------------------
// D-227: o recurso só no plano que o inclui (Pro = 0, Max = 1)
// ---------------------------------------------------------------------------

describe("handler: comentário do Instagram fora do plano", () => {
  it("plano sem o recurso (Pro): a automação com gatilho de comentário não dispara nem cria contato", async () => {
    const d = db(config(gatilho()), { comentarioDoInstagramNoPlano: async () => false });
    const r = await aplicarGatilhosDeAutomacao(d.fake, evento());
    expect(r.iniciadas).toBe(0);
    expect(d.iniciadas).toHaveLength(0);
    expect(d.criados).toHaveLength(0);
  });

  it("plano com o recurso (Max): dispara", async () => {
    const d = db(config(gatilho()), { comentarioDoInstagramNoPlano: async () => true });
    expect((await aplicarGatilhosDeAutomacao(d.fake, evento())).iniciadas).toBe(1);
  });
});

/** O cliente de serviço no limite da rede: contrato + `fn_billing_limites_efetivos`. */
function adminDoPlano(limites: Record<string, number | null> | "erro"): SupabaseClient {
  const contrato = {
    select: () => contrato,
    eq: () => contrato,
    maybeSingle: async () => ({
      data: { status: "ativa", cycle: "monthly", billing_plans: { code: "pro", name: "Pro", version: 2 } },
      error: null,
    }),
  };
  const sete = { funis: 5, etapas_por_funil: 10, leads: 5000, membros: 3, conexoes: 3, integracoes_webhook: 3, tokens_ia_mes: 1 };
  return {
    from: () => contrato,
    rpc: async () =>
      limites === "erro"
        ? { data: null, error: { message: "banco fora" } }
        : {
            data: {
              ...sete,
              agentes_ia: 1,
              automacoes: 10,
              mcp_req_min: 0,
              acesso_api: 0,
              automacao_comentario_instagram: 0,
              fonte_dados_req_min: 60,
              ...limites,
            },
            error: null,
          },
  } as unknown as SupabaseClient;
}

describe("comentarioDoInstagramNoPlano: leitura que falha nega", () => {
  it("Pro (0) não inclui, Max (1) inclui, sem limite (null) inclui", async () => {
    expect(await comentarioDoInstagramNoPlano(adminDoPlano({ automacao_comentario_instagram: 0 }), ORG)).toBe(false);
    expect(await comentarioDoInstagramNoPlano(adminDoPlano({ automacao_comentario_instagram: 1 }), ORG)).toBe(true);
    expect(await comentarioDoInstagramNoPlano(adminDoPlano({ automacao_comentario_instagram: null }), ORG)).toBe(true);
  });

  it("o banco não respondeu: não inclui", async () => {
    expect(await comentarioDoInstagramNoPlano(adminDoPlano("erro"), ORG)).toBe(false);
  });

  it("grafoUsaComentarioDoInstagram só olha o bloco Início", () => {
    const inicio = (kind: string) => ({ nodes: [{ id: "t", type: "trigger", config: { triggers: [{ kind }] } }] });
    expect(grafoUsaComentarioDoInstagram(inicio("instagram_comment"))).toBe(true);
    expect(grafoUsaComentarioDoInstagram(inicio("lead_created"))).toBe(false);
    expect(grafoUsaComentarioDoInstagram(null)).toBe(false);
  });
});
