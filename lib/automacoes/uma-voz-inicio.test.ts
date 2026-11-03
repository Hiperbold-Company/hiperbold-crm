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
  /**
   * Execuções: origem, se o grafo da versão tem bloco de conversa, se está viva
   * (`active`/`waiting_reply`, padrão sim) e se já falou na conversa.
   */
  execucoes?: Array<{
    org: string;
    lane: string;
    origin_event_id: string;
    conversa: boolean;
    viva?: boolean;
    falou?: boolean;
  }>;
  /** Automações ativas com gatilho "mensagem recebida": se têm bloco de conversa e os gatilhos. */
  armadas?: Array<{ org: string; conversa: boolean; triggers?: unknown[] }>;
  /** A linha da mensagem (padrão: texto "oi", chegou agora). */
  mensagem?: { body: string; idadeMs: number; channel_session_id?: string } | null;
  /** Há inbound ANTERIOR na conversa (para "só a primeira"). */
  inboundAnterior?: boolean;
}

const QUALQUER = [{ kind: "message_received", match: "any", keywords: [] }];

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
      // A regra da consulta: nascida deste evento, com bloco de conversa, e
      // viva OU que já falou (só então a IA cede).
      const achou = (c.execucoes ?? []).some(
        (x) =>
          x.org === org &&
          x.lane === "automacao" &&
          x.origin_event_id === origem &&
          x.conversa &&
          (x.viva !== false || x.falou === true),
      );
      return { rows: achou ? [{ "?column?": 1 }] : [] };
    }
    if (sql.includes("'message_received'")) {
      const [org] = params as [string];
      return {
        rows: (c.armadas ?? [])
          .filter((a) => a.org === org && a.conversa)
          .map((a) => ({ triggers: a.triggers ?? QUALQUER })),
      };
    }
    if (sql.includes("select body, type, channel_session_id")) {
      const [org, msg] = params as [string, string];
      const m = c.mensagem === undefined ? { body: "oi", idadeMs: 1000 } : c.mensagem;
      if (!m || org !== ORG || msg !== INBOUND) return { rows: [] };
      return {
        rows: [
          {
            body: m.body,
            type: "text",
            channel_session_id: m.channel_session_id ?? "33333333-3333-4333-8333-333333333333",
            conversation_id: CONV,
            created_at: new Date(Date.now() - m.idadeMs).toISOString(),
          },
        ],
      };
    }
    if (sql.includes("created_at < $4")) {
      return { rows: c.inboundAnterior ? [{ "?column?": 1 }] : [] };
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

describe("uma voz no início: a execução cedida precisa estar viva ou ter falado", () => {
  it("a execução nascida da mensagem já TERMINOU sem falar: a IA responde", async () => {
    const d = poolDoDrain({
      evento: CONSUMIDO,
      execucoes: [
        { org: ORG, lane: "automacao", origin_event_id: "ev-msg", conversa: true, viva: false, falou: false },
      ],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(true);
  });

  it("terminou, mas falou na conversa: a IA continua calada", async () => {
    const d = poolDoDrain({
      evento: CONSUMIDO,
      execucoes: [
        { org: ORG, lane: "automacao", origin_event_id: "ev-msg", conversa: true, viva: false, falou: true },
      ],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(false);
  });

  it("execução de OUTRA organização com a mesma origem não cala a IA", async () => {
    const d = poolDoDrain({
      evento: CONSUMIDO,
      execucoes: [{ org: "org-2", lane: "automacao", origin_event_id: "ev-msg", conversa: true }],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(true);
  });
});

describe("uma voz no início: só espera se algum gatilho armado pode casar a mensagem", () => {
  const pendente = { ...CONSUMIDO, consumed_by: [], status: "pending" };
  const palavra = (k: string) => [{ kind: "message_received", match: "contains", keywords: [k] }];

  it("a palavra-chave do gatilho armado casa: espera", async () => {
    const d = poolDoDrain({
      evento: pendente,
      armadas: [{ org: ORG, conversa: true, triggers: palavra("preço") }],
      mensagem: { body: "Qual o PRECO?", idadeMs: 1000 },
    });
    await drainTick(d.pool, knobs, log);
    expect(d.adiou()).toBe(true);
    expect(d.enfileirou()).toBe(false);
  });

  it("a palavra-chave não casa: a IA responde sem esperar", async () => {
    const d = poolDoDrain({
      evento: pendente,
      armadas: [{ org: ORG, conversa: true, triggers: palavra("boleto") }],
      mensagem: { body: "Qual o preço?", idadeMs: 1000 },
    });
    await drainTick(d.pool, knobs, log);
    expect(d.adiou()).toBe(false);
    expect(d.enfileirou()).toBe(true);
  });

  it("canal diferente do gatilho: não espera", async () => {
    const d = poolDoDrain({
      evento: pendente,
      armadas: [
        {
          org: ORG,
          conversa: true,
          triggers: [
            {
              kind: "message_received",
              match: "any",
              keywords: [],
              channel_session_ids: ["55555555-5555-4555-8555-555555555555"],
            },
          ],
        },
      ],
    });
    await drainTick(d.pool, knobs, log);
    expect(d.adiou()).toBe(false);
    expect(d.enfileirou()).toBe(true);
  });

  it("só a primeira mensagem e já há mensagem ANTERIOR do contato: não espera", async () => {
    const d = poolDoDrain({
      evento: pendente,
      armadas: [
        {
          org: ORG,
          conversa: true,
          triggers: [{ kind: "message_received", match: "any", keywords: [], only_first_message: true }],
        },
      ],
      inboundAnterior: true,
    });
    await drainTick(d.pool, knobs, log);
    expect(d.adiou()).toBe(false);
  });

  it("mensagem com mais de 10 minutos: não espera (o handler não a usa)", async () => {
    const d = poolDoDrain({
      evento: pendente,
      armadas: [{ org: ORG, conversa: true }],
      mensagem: { body: "oi", idadeMs: 11 * 60_000 },
    });
    await drainTick(d.pool, knobs, log);
    expect(d.adiou()).toBe(false);
    expect(d.enfileirou()).toBe(true);
  });
});
