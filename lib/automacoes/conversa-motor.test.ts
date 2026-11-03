/**
 * O bloco de mensagem com opções pelo MOTOR inteiro (engine + decisões +
 * eventos), com um banco em memória e um executor que só registra o que lhe
 * pediram: envia, estaciona em `waiting_reply`, recusa a resposta inválida com
 * nova tentativa, aceita a opção pelo número, grava `vars.resposta` e segue
 * pelo caminho da opção até o fim — tudo pelo mesmo `processEnrollment` que o
 * relógio usa.
 */
import { describe, expect, it } from "vitest";

import {
  avancarEnrollmentAtivo,
  type AdminClient,
  type ExecutorDeEfeitos,
  type PedidoDeEfeito,
  type TickDeps,
} from "@/lib/followup/engine";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "@/lib/followup/node-handlers";

import type { RespostaRecebida } from "./conversa";

const pos = { x: 0, y: 0 };
const GRAFO = flowGraphSchema.parse({
  nodes: [
    {
      id: "t",
      type: "trigger",
      label: "Início",
      position: pos,
      config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
    },
    {
      id: "message-1",
      type: "message",
      label: "Pergunta do interesse",
      position: pos,
      config: {
        body: "Qual o seu interesse?",
        options: { kind: "buttons", items: [{ id: "moradia", label: "Moradia" }, { id: "invest", label: "Investimento" }] },
        reply_timeout_ms: 3_600_000,
        invalid_reply: { message: "Responda 1 ou 2.", attempts: 1 },
      },
    },
    { id: "fim-moradia", type: "end", label: "Fim", position: pos, config: { outcome: "converted" } },
    { id: "fim-invest", type: "end", label: "Fim", position: pos, config: { outcome: "custom", note: "investidor" } },
  ],
  edges: [
    { id: "e0", source: "t", target: "message-1", condition: { type: "always" } },
    { id: "e1", source: "message-1", target: "fim-moradia", condition: { type: "branch", branch_id: "moradia" } },
    { id: "e2", source: "message-1", target: "fim-invest", condition: { type: "branch", branch_id: "invest" } },
  ],
});

function montar() {
  let agora = new Date("2026-11-03T12:00:00.000Z");
  const eventos: EnrollmentEventRef[] = [];
  const recebidas: Array<RespostaRecebida & { em: string }> = [];
  const pedidos: PedidoDeEfeito[] = [];
  let row: EnrollmentRow = {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "c-1",
    conversation_id: null,
    current_node_id: "t",
    status: "active",
    next_eval_at: agora.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 0,
    outcome: null,
    cancel_reason: null,
    started_at: agora.toISOString(),
    completed_at: null,
    updated_at: agora.toISOString(),
    lane: "automacao",
    vars: {},
  };
  const db: AdminClient = {
    claimDueEnrollments: async () => [],
    loadFlowGraph: async () => GRAFO,
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadEnrollmentEvents: async () => eventos.map((e) => ({ ...e })),
    loadLastInboundBody: async () => null,
    insertEnrollmentEvent: async (e) => {
      if (eventos.some((x) => x.idempotency_key === e.idempotency_key)) return { inserted: false };
      eventos.push({ node_id: e.node_id, idempotency_key: e.idempotency_key, event_type: e.event_type, payload: e.payload });
      return { inserted: true };
    },
    updateEnrollment: async (_id, _org, patch) => {
      row = { ...row, ...patch } as EnrollmentRow;
    },
    loadFlowPointerName: async () => "Automação",
    insertDeadInboxItem: async () => {},
    persistirRespostaFollowup: async () => {},
    loadFatosDaAutomacao: async (_o, _c, vars) => ({ contato: null, negocio: null, negocios: [], vars }),
    loadRespostasDaEspera: async (_o, _c, desde) => recebidas.filter((r) => r.em >= desde),
  };
  const efeitos: ExecutorDeEfeitos = {
    async executar(p) {
      pedidos.push(p);
      if (p.acao?.tipo === "registrar_resposta") {
        return {
          desfecho: { ok: true },
          vars: { resposta: { message_1: p.acao.valor, message_1_opcao: p.acao.opcao_id } },
          detalhes: [{ tipo: "message", envio: "resposta" }],
        };
      }
      return { desfecho: { ok: true }, detalhes: [{ tipo: "message", envio: p.acao?.tipo === "enviar" ? p.acao.envio : "?" }] };
    },
  };
  const deps: TickDeps = { db, clock: () => agora, enqueueJob: async () => {}, efeitos };
  return {
    deps,
    get row() {
      return row;
    },
    pedidos,
    eventos,
    avancar(ms: number) {
      agora = new Date(agora.getTime() + ms);
    },
    contatoEscreve(texto: string, replyId: string | null = null) {
      recebidas.push({ texto, replyId, em: agora.toISOString() });
    },
    tick: () => avancarEnrollmentAtivo(deps, row),
  };
}

describe("bloco de mensagem com opções no motor", () => {
  it("envia, espera, recusa a inválida com nova tentativa, aceita o número e segue pela opção", async () => {
    const m = montar();
    await m.tick();
    expect(m.pedidos.map((p) => p.acao)).toEqual([{ tipo: "enviar", envio: "mensagem" }]);
    expect(m.row.status).toBe("waiting_reply");
    expect(m.row.current_node_id).toBe("message-1");

    // Acordado sem resposta nova: continua esperando, com o mesmo prazo, sem enviar.
    const prazo = m.row.next_eval_at;
    m.avancar(60_000);
    await m.tick();
    expect(m.pedidos).toHaveLength(1);
    expect(m.row.next_eval_at).toBe(prazo);

    m.avancar(60_000);
    m.contatoEscreve("talvez");
    await m.tick();
    expect(m.pedidos.at(-1)?.acao).toEqual({ tipo: "enviar", envio: "nova_tentativa" });
    expect(m.row.status).toBe("waiting_reply");

    // A inválida de antes da nova tentativa não conta de novo; o "2" de agora, sim.
    m.avancar(60_000);
    m.contatoEscreve("2");
    await m.tick();
    expect(m.pedidos.at(-1)?.acao).toEqual({ tipo: "registrar_resposta", valor: "Investimento", opcao_id: "invest" });
    expect(m.row.status).toBe("completed");
    expect(m.row.cancel_reason).toBe("investidor");
    expect(m.row.vars).toMatchObject({ resposta: { message_1: "Investimento", message_1_opcao: "invest" } });
    // Nenhum evento guarda o texto do contato.
    expect(JSON.stringify(m.eventos)).not.toContain("talvez");
  });

  it("sem resposta até o prazo: sem ramo ligado, a execução termina (não fica presa)", async () => {
    const m = montar();
    await m.tick();
    m.avancar(3_600_000);
    await m.tick();
    expect(m.row.status).toBe("completed");
    expect(m.pedidos).toHaveLength(1);
  });
});
