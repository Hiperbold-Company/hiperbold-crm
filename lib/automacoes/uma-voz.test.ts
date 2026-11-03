/**
 * UMA VOZ pelo DRAIN do agente: a IA só cede o turno quando uma execução de
 * automação espera resposta E a mensagem chegou na conversa em que essa
 * execução falou. Medido pelo desfecho do drain (enfileirou o turno ou não),
 * com um banco falso que aplica a regra da consulta aos dados — não pela
 * leitura do código-fonte.
 */
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";

import { automacaoEsperaRespostaNaConversa } from "./uma-voz";

const ORG = "org-1";
const CONV_WA = "11111111-1111-4111-8111-111111111111";
const CONV_IG = "55555555-5555-4555-8555-555555555555";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const INBOUND = "44444444-4444-4444-8444-444444444444";

interface Execucao {
  id: string;
  org: string;
  lane: string;
  status: string;
}
interface Mensagem {
  org: string;
  conversa: string;
  direcao: "inbound" | "outbound";
  enrollmentId: string | null;
}

/** Aplica a regra de `automacaoEsperaRespostaNaConversa` aos dados, como o Postgres. */
function responderUmaVoz(params: unknown[], execucoes: Execucao[], mensagens: Mensagem[]) {
  const [org, conversa] = params as [string, string];
  const achou = execucoes.some(
    (e) =>
      e.org === org &&
      e.lane === "automacao" &&
      e.status === "waiting_reply" &&
      mensagens.some((m) => m.org === org && m.conversa === conversa && m.direcao === "outbound" && m.enrollmentId === e.id),
  );
  return { rows: achou ? [{ "?column?": 1 }] : [] };
}

function poolDoDrain(conversa: string, execucoes: Execucao[], mensagens: Mensagem[]) {
  const calls: string[] = [];
  const evento = {
    id: "e1",
    organization_id: ORG,
    attempts: 1,
    created_at: new Date().toISOString(),
    payload: {
      conversation_id: conversa,
      contact_id: CONTATO,
      channel_session_id: "33333333-3333-4333-8333-333333333333",
      inbound_message_id: INBOUND,
    },
  };
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes("returning e.id")) return { rows: [evento] };
    if (sql.includes("ai_dispatch_mode")) return { rows: [{ mode: null, status: "active" }] };
    if (sql.includes("is_group")) return { rows: [{ is_group: false }] };
    if (sql.includes("tem_agente")) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    if (sql.includes("origem_automacao")) return responderUmaVoz(params, execucoes, mensagens);
    if (sql.includes("insert into job_queue")) return { rows: [{ id: "job-1" }] };
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, enfileirou: () => calls.some((s) => s.includes("insert into job_queue")) };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const knobs = { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 0, reapTimeoutMs: 60000 };

const ESPERANDO: Execucao = { id: "enr-1", org: ORG, lane: "automacao", status: "waiting_reply" };
const ENVIOU_NO_WA: Mensagem = { org: ORG, conversa: CONV_WA, direcao: "outbound", enrollmentId: "enr-1" };

describe("uma voz no drain do agente", () => {
  it("execução esperando e mensagem na conversa em que ela falou: a IA cede (sem turno)", async () => {
    const d = poolDoDrain(CONV_WA, [ESPERANDO], [ENVIOU_NO_WA]);
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(false);
  });

  it("mesma execução esperando, mas a mensagem veio por OUTRA conversa (Instagram, outro número): a IA responde", async () => {
    const d = poolDoDrain(CONV_IG, [ESPERANDO], [ENVIOU_NO_WA]);
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(true);
  });

  it("execução que não está esperando, de outra raia ou de outra organização: a IA responde", async () => {
    for (const e of [
      { ...ESPERANDO, status: "active" },
      { ...ESPERANDO, lane: "followup" },
      { ...ESPERANDO, org: "org-2" },
    ]) {
      const d = poolDoDrain(CONV_WA, [e], [ENVIOU_NO_WA]);
      await drainTick(d.pool, knobs, log);
      expect(d.enfileirou()).toBe(true);
    }
  });

  it("espera sem nenhum envio da execução nesta conversa: a IA responde", async () => {
    const d = poolDoDrain(CONV_WA, [ESPERANDO], [{ ...ENVIOU_NO_WA, enrollmentId: "outra" }]);
    await drainTick(d.pool, knobs, log);
    expect(d.enfileirou()).toBe(true);
  });

  it("consulta que falha não cala a IA (fail-open)", async () => {
    const quebrado = { query: (async () => { throw new Error("db fora"); }) as unknown as pg.Pool["query"] };
    expect(await automacaoEsperaRespostaNaConversa(quebrado, { organizationId: ORG, conversationId: CONV_WA })).toBe(false);
  });
});
