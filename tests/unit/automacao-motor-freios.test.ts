import { describe, expect, it, vi } from "vitest";

import { criarExecutorDeEfeitos } from "../../lib/automacoes/efeitos";
import {
  avancarEnrollmentAtivo,
  codigoDoErroDeEfeito,
  createSupabaseAdminClient,
  LIMITE_DE_EVENTOS_DA_AUTOMACAO,
  type AdminClient,
  type TickDeps,
} from "../../lib/followup/engine";
import type { FlowGraph, FlowNode } from "../../lib/followup/graph-schema";
import type { EnrollmentRow } from "../../lib/followup/node-handlers";

/**
 * Freios do motor das automações, revisão do lote 1:
 *  - B9: organização suspensa não muda o CRM pelo executor de efeitos;
 *  - B10: a execução de automação lê só os eventos mais recentes, e o follow-up
 *    continua lendo todos (comportamento dele intacto);
 *  - C4: o log de erro de efeito leva só o código, nunca a mensagem crua.
 */
const NOW = new Date("2026-11-02T12:00:00.000Z");

function enrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: null,
    current_node_id: "cond-1",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 4,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("B9 — executor de efeitos com a organização suspensa", () => {
  const ACAO = {
    id: "a",
    type: "crm_action",
    label: "Ação",
    position: { x: 0, y: 0 },
    config: { on_error: "continue", actions: [{ type: "add_tags", target: "contact", tags: ["x"] }] },
  } as unknown as FlowNode;

  it("não lê nem escreve nada e sai por Erro com organizacao_bloqueada", async () => {
    const from = vi.fn(() => {
      throw new Error("tocou o banco");
    });
    const rpc = vi.fn();
    const executor = criarExecutorDeEfeitos({ from, rpc } as never, { podeProduzir: async () => false });
    const r = await executor.executar({
      enrollment: enrollment({ lane: "automacao" } as Partial<EnrollmentRow>),
      node: ACAO,
      fatos: null,
      chave: "a:4",
    });
    expect(r.desfecho).toEqual({ ok: false, erro: "organizacao_bloqueada" });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("organização em dia: o efeito segue o caminho normal (controle)", async () => {
    const podeProduzir = vi.fn(async () => true);
    const executor = criarExecutorDeEfeitos({ from: vi.fn(), rpc: vi.fn() } as never, { podeProduzir });
    const r = await executor.executar({ enrollment: enrollment(), node: ACAO, fatos: null, chave: "a:4" });
    expect(podeProduzir).toHaveBeenCalledWith("org-1");
    expect(r.desfecho).not.toEqual({ ok: false, erro: "organizacao_bloqueada" });
  });
});

describe("C4 — código do erro de efeito, sem a mensagem", () => {
  it("erro de banco: o código, nunca o texto", () => {
    const err = Object.assign(new Error("duplicate key: (phone)=(5511999990000) Maria"), { code: "23505" });
    expect(codigoDoErroDeEfeito(err)).toBe("23505");
  });
  it("erro comum: o nome da classe", () => {
    expect(codigoDoErroDeEfeito(new TypeError("Maria Titular não tem negócio"))).toBe("TypeError");
  });
  it("valor solto ou código com texto livre: genérico", () => {
    expect(codigoDoErroDeEfeito("Maria 11999990000")).toBe("erro_desconhecido");
    expect(codigoDoErroDeEfeito({ code: "falhou para Maria Titular" })).toBe("erro_desconhecido");
  });
});

describe("B10 — eventos lidos por tick", () => {
  it("o carregador com limite pede os N mais recentes e devolve em ordem cronológica", async () => {
    const chamadas: Array<[string, unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) {
      q[m] = (...args: unknown[]) => {
        chamadas.push([m, args]);
        if (m === "limit") {
          return Promise.resolve({
            data: [
              { node_id: "c", idempotency_key: "3", event_type: "x", payload: {} },
              { node_id: "b", idempotency_key: "2", event_type: "x", payload: {} },
            ],
            error: null,
          });
        }
        return q;
      };
    }
    const db = createSupabaseAdminClient({ from: () => q } as never);
    const eventos = await db.loadEnrollmentEvents("enr-1", 2);
    expect(eventos.map((e) => e.idempotency_key)).toEqual(["2", "3"]);
    expect(chamadas).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(chamadas).toContainEqual(["limit", [2]]);
  });

  const GRAFO = {
    nodes: [
      { id: "cond-1", type: "condition", config: { checks: [{ field: "tag", op: "contains", value: "x" }], combinator: "and" } },
      { id: "sim", type: "end", config: { outcome: "converted" } },
      { id: "nao", type: "end", config: { outcome: "exhausted" } },
    ],
    edges: [
      { id: "e1", source: "cond-1", target: "sim", priority: 0, condition: { type: "branch", branch: "sim" } },
      { id: "e2", source: "cond-1", target: "nao", priority: 1, condition: { type: "branch", branch: "nao" } },
    ],
  } as unknown as FlowGraph;

  async function limitePedido(lane: "automacao" | "followup"): Promise<unknown> {
    const loadEnrollmentEvents = vi.fn(async () => []);
    const base: Record<string, unknown> = {
      loadFlowGraph: vi.fn(async () => GRAFO),
      loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
      loadEnrollmentEvents,
      insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    };
    const db = new Proxy(base, { get: (alvo, chave) => alvo[chave as string] ?? (async () => null) }) as unknown as AdminClient;
    const deps: TickDeps = { db, clock: () => NOW, enqueueJob: async () => {} };
    await avancarEnrollmentAtivo(deps, enrollment({ lane } as Partial<EnrollmentRow>)).catch(() => undefined);
    expect(loadEnrollmentEvents).toHaveBeenCalled();
    return (loadEnrollmentEvents.mock.calls[0] as unknown[])[1];
  }

  it("automação pede o teto", async () => {
    expect(await limitePedido("automacao")).toBe(LIMITE_DE_EVENTOS_DA_AUTOMACAO);
  });

  it("follow-up continua lendo tudo", async () => {
    expect(await limitePedido("followup")).toBeUndefined();
  });
});
