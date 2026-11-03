/**
 * UMA VOZ NO INÍCIO, pelo desfecho do DRAIN do agente: a mensagem que iniciou
 * uma automação com bloco de conversa não ganha turno da IA; enquanto o handler
 * dos gatilhos não decidiu e há automação armada, o turno é ADIADO (até o
 * teto); automação sem bloco de conversa não cala a IA. O banco falso aplica a
 * regra de cada consulta aos dados.
 */
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";

import { AUTOMACAO_GATILHOS_HANDLER_KEY } from "./chaves";
import { TETO_DA_ESPERA_PELO_GATILHO_MS } from "./uma-voz";

const ORG = "org-1";
const CONV = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const INBOUND = "44444444-4444-4444-8444-444444444444";

interface Cenario {
  /** A linha `message.received` desta mensagem no event_log (ou nenhuma). */
  evento?: { id: string; consumed_by: string[]; status: string; idadeMs: number };
  /** Execuções: origem e se o grafo da versão tem bloco de conversa. */
  execucoes?: Array<{ org: string; lane: string; origin_event_id: string; conversa: boolean }>;
  /** Automações ativas com gatilho "mensagem recebida": se têm bloco de conversa. */
  armadas?: Array<{ org: string; conversa: boolean }>;
}

function poolDoDrain(c: Cenario) {
  const calls: string[] = [];
  const despacho = {
    id: "d1",
    organization_id: ORG,
    attempts: 1,
    created_at: new Date().toISOString(),
    payload: {
      conversation_id: CONV,
      contact_id: CONTATO,
      channel_session_id: "33333333-3333-4333-8333-333333333333",
      inbound_message_id: INBOUND,
    },
  };
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes("returning e.id")) return { rows: [despacho] };
    if (sql.includes("ai_dispatch_mode")) return { rows: [{ mode: null, status: "active" }] };
    if (sql.includes("is_group")) return { rows: [{ is_group: false }] };
    if (sql.includes("tem_agente")) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    if (sql.includes("event_type = 'message.received'")) {
      const [org, msg, chave] = params as [string, string, string];
      const e = c.evento;
      if (!e || org !== ORG || msg !== INBOUND) return { rows: [] };
      return {
        rows: [
          {
            id: e.id,
            consumido: e.consumed_by.includes(chave),
            status: e.status,
            created_at: new Date(Date.now() - e.idadeMs).toISOString(),
          },
        ],
      };
    }
    if (sql.includes("e.origin_event_id = $2")) {
      const [org, origem] = params as [string, string];
      const achou = (c.execucoes ?? []).some(
        (x) =>
          x.org === org && x.lane === "automacao" && x.origin_event_id === origem && x.conversa,
      );
      return { rows: achou ? [{ "?column?": 1 }] : [] };
    }
    if (sql.includes("'message_received'")) {
      const [org] = params as [string];
      return {
        rows: (c.armadas ?? []).some((a) => a.org === org && a.conversa) ? [{ "?column?": 1 }] : [],
      };
    }
    if (sql.includes("insert into job_queue")) return { rows: [{ id: "job-1" }] };
    return { rows: [] };
  });
  return {
    pool: { query } as unknown as pg.Pool,
    enfileirou: () => calls.some((s) => s.includes("insert into job_queue")),
    adiou: () => calls.some((s) => s.includes("attempts = greatest(attempts - 1, 0)")),
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const knobs = {
  batchSize: 10,
  intervalMs: 0,
  idleIntervalMs: 0,
  debounceMs: 0,
  reapTimeoutMs: 60000,
};
const CONSUMIDO = {
  id: "ev-msg",
  consumed_by: [AUTOMACAO_GATILHOS_HANDLER_KEY],
  status: "processing",
  idadeMs: 1000,
};

describe("uma voz no início (gatilho mensagem recebida)", () => {
  it("a mensagem iniciou automação com Mensagem/Pergunta: a IA não responde", async () => {
    const d = poolDoDrain({
      evento: CONSUMIDO,
      execucoes: [{ org: ORG, lane: "automacao", origin_event_id: "ev-msg", conversa: true }],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(false);
    expect(d.adiou()).toBe(false);
  });

  it("a automação iniciada não tem bloco de conversa: a IA responde", async () => {
    const d = poolDoDrain({
      evento: CONSUMIDO,
      execucoes: [{ org: ORG, lane: "automacao", origin_event_id: "ev-msg", conversa: false }],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(true);
  });

  it("o gatilho já decidiu e não iniciou nada (não casou, reentrada, teto): a IA responde", async () => {
    const d = poolDoDrain({
      evento: CONSUMIDO,
      execucoes: [{ org: ORG, lane: "automacao", origin_event_id: "outro-evento", conversa: true }],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(true);
  });

  it("o gatilho ainda não decidiu e há automação armada com conversa: o turno é adiado", async () => {
    const d = poolDoDrain({
      evento: { ...CONSUMIDO, consumed_by: [], status: "pending" },
      armadas: [{ org: ORG, conversa: true }],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(false);
    expect(d.adiou()).toBe(true);
  });

  it("ainda não decidiu, mas nenhuma automação armada tem bloco de conversa: a IA responde sem esperar", async () => {
    const d = poolDoDrain({
      evento: { ...CONSUMIDO, consumed_by: [], status: "pending" },
      armadas: [{ org: ORG, conversa: false }],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(true);
  });

  it("passado o teto da espera, a IA responde (fail-open)", async () => {
    const d = poolDoDrain({
      evento: {
        ...CONSUMIDO,
        consumed_by: [],
        status: "pending",
        idadeMs: TETO_DA_ESPERA_PELO_GATILHO_MS + 1000,
      },
      armadas: [{ org: ORG, conversa: true }],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(true);
  });
});
