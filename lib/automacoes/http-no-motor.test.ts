/**
 * O bloco "Requisição HTTP" pelo MOTOR inteiro (`avancarEnrollmentAtivo`, o
 * mesmo passo do relógio), com banco em memória. O executor é o dublê do
 * outro sistema: registra que foi chamado e devolve o que a resposta traria.
 *
 * O que se prova aqui é a parte do motor que a auditoria do lote 4 apontou:
 *  - lease curto não começa a chamada (sem isso, outro tick reclama a
 *    inscrição e grava `efeito_interrompido` por cima de uma chamada que deu
 *    certo);
 *  - teto de chamadas HTTP por execução;
 *  - o que a resposta devolveu (`saida`) não vai ao evento — só os nomes —, e
 *    mesmo assim sobrevive ao replay, porque vai antes para `enrollments.vars`.
 */
import { describe, expect, it } from "vitest";

import {
  avancarEnrollmentAtivo,
  FOLGA_DO_LEASE_HTTP_MS,
  MAX_HTTP_POR_EXECUCAO,
  type AdminClient,
  type ExecutorDeEfeitos,
  type PedidoDeEfeito,
  type TickDeps,
} from "@/lib/followup/engine";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "@/lib/followup/node-handlers";

const pos = { x: 0, y: 0 };
const TIMEOUT = 10_000;
const GRAFO = flowGraphSchema.parse({
  nodes: [
    {
      id: "t",
      type: "trigger",
      label: "Início",
      position: pos,
      config: {
        triggers: [{ kind: "manual" }],
        reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
      },
    },
    {
      id: "h",
      type: "http_request",
      label: "Chamar API",
      position: pos,
      config: {
        method: "GET",
        url: "https://api.exemplo.com/v1",
        headers: [],
        timeout_ms: TIMEOUT,
        mappings: [{ path: "id", var: "pedido" }],
      },
    },
    { id: "ok", type: "end", label: "Fim", position: pos, config: { outcome: "converted" } },
    {
      id: "falhou",
      type: "end",
      label: "Fim",
      position: pos,
      config: { outcome: "custom", note: "falhou" },
    },
  ],
  edges: [
    { id: "e0", source: "t", target: "h", condition: { type: "always" } },
    { id: "e1", source: "h", target: "ok", condition: { type: "always" } },
    { id: "e2", source: "h", target: "falhou", condition: { type: "branch", branch_id: "erro" } },
  ],
});

function montar(
  opts: { claimedUntilEmMs?: number | null; eventosAntes?: EnrollmentEventRef[] } = {},
) {
  const agora = new Date("2026-11-10T12:00:00.000Z");
  const eventos: EnrollmentEventRef[] = [...(opts.eventosAntes ?? [])];
  const pedidos: PedidoDeEfeito[] = [];
  const patches: Array<Record<string, unknown>> = [];
  let row: EnrollmentRow = {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "c-1",
    conversation_id: null,
    current_node_id: "h",
    status: "active",
    next_eval_at: agora.toISOString(),
    claimed_until:
      opts.claimedUntilEmMs === null || opts.claimedUntilEmMs === undefined
        ? null
        : new Date(agora.getTime() + opts.claimedUntilEmMs).toISOString(),
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
    vars: { gatilho: { tipo: "manual" } },
  };
  const db: AdminClient = {
    claimDueEnrollments: async () => [],
    loadFlowGraph: async () => GRAFO,
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadEnrollmentEvents: async () => eventos.map((e) => ({ ...e })),
    loadLastInboundBody: async () => null,
    insertEnrollmentEvent: async (e) => {
      if (eventos.some((x) => x.idempotency_key === e.idempotency_key)) return { inserted: false };
      eventos.push({
        node_id: e.node_id,
        idempotency_key: e.idempotency_key,
        event_type: e.event_type,
        payload: e.payload,
      });
      return { inserted: true };
    },
    updateEnrollment: async (_id, _org, patch) => {
      patches.push(patch as Record<string, unknown>);
      row = { ...row, ...patch } as EnrollmentRow;
    },
    loadFlowPointerName: async () => "Automação",
    insertDeadInboxItem: async () => {},
    persistirRespostaFollowup: async () => {},
    loadFatosDaAutomacao: async (_o, _c, vars) => ({
      contato: null,
      negocio: null,
      negocios: [],
      vars,
    }),
  };
  const efeitos: ExecutorDeEfeitos = {
    async executar(p) {
      pedidos.push(p);
      return {
        desfecho: { ok: true },
        vars: { saida: { pedido: "PED-123 de Maria Silva" } },
        detalhes: [
          {
            tipo: "http_request",
            ok: true,
            metodo: "GET",
            host: "api.exemplo.com",
            caminho: "/v1",
            status: 200,
            campos: ["pedido"],
          },
        ],
      };
    },
  };
  const deps: TickDeps = { db, clock: () => agora, enqueueJob: async () => {}, efeitos };
  return {
    get row() {
      return row;
    },
    eventos,
    pedidos,
    patches,
    tick: () => avancarEnrollmentAtivo(deps, row),
  };
}

describe("bloco HTTP no motor — lease", () => {
  it("lease que não cobre tempo limite + folga: a chamada NÃO começa, o claim é solto e nada fica marcado", async () => {
    const m = montar({ claimedUntilEmMs: TIMEOUT + FOLGA_DO_LEASE_HTTP_MS - 1 });
    await m.tick();
    expect(m.pedidos).toHaveLength(0);
    // Sem `effect_started`: o tick seguinte não tem por que gravar `efeito_interrompido`.
    expect(m.eventos.filter((e) => e.node_id === "h")).toEqual([]);
    expect(m.row.claimed_until).toBeNull();
    expect(m.row.current_node_id).toBe("h");
    expect(m.row.status).toBe("active");
  });

  it("com lease novo (o tick seguinte) a chamada acontece e sai por Deu certo — nunca efeito_interrompido", async () => {
    const m = montar({ claimedUntilEmMs: TIMEOUT + FOLGA_DO_LEASE_HTTP_MS - 1 });
    await m.tick();
    expect(m.pedidos).toHaveLength(0);
    // O próximo claim dá 120 s de lease.
    const m2 = montar({ claimedUntilEmMs: 120_000 });
    await m2.tick();
    expect(m2.pedidos).toHaveLength(1);
    const fim = m2.eventos.find(
      (e) => e.event_type === "effect_done" || e.event_type === "effect_failed",
    );
    expect(fim?.event_type).toBe("effect_done");
    expect(JSON.stringify(m2.eventos)).not.toContain("efeito_interrompido");
    expect(m2.row.current_node_id).toBe("ok");
  });

  it("sem lease (caminho sem claim) a chamada roda (controle)", async () => {
    const m = montar({ claimedUntilEmMs: null });
    await m.tick();
    expect(m.pedidos).toHaveLength(1);
  });
});

describe("bloco HTTP no motor — teto por execução", () => {
  it(`com ${MAX_HTTP_POR_EXECUCAO} chamadas já feitas na execução, a próxima sai por Falhou sem chamar`, async () => {
    const antes: EnrollmentEventRef[] = Array.from({ length: MAX_HTTP_POR_EXECUCAO }, (_, i) => ({
      node_id: `h${i}`,
      idempotency_key: `h${i}:${i}:efeito_inicio`,
      event_type: "effect_started",
      payload: { tipo: "http_request" },
    }));
    const m = montar({ claimedUntilEmMs: 120_000, eventosAntes: antes });
    await m.tick();
    expect(m.pedidos).toHaveLength(0);
    const fim = m.eventos.find((e) => e.event_type === "effect_failed" && e.node_id === "h");
    expect((fim?.payload?.desfecho as { erro?: string }).erro).toBe("http_limite_por_execucao");
    expect(m.row.current_node_id).toBe("falhou");
  });

  it("uma a menos que o teto ainda chama (controle)", async () => {
    const antes: EnrollmentEventRef[] = Array.from(
      { length: MAX_HTTP_POR_EXECUCAO - 1 },
      (_, i) => ({
        node_id: `h${i}`,
        idempotency_key: `h${i}:${i}:efeito_inicio`,
        event_type: "effect_started",
        payload: { tipo: "http_request" },
      }),
    );
    const m = montar({ claimedUntilEmMs: 120_000, eventosAntes: antes });
    await m.tick();
    expect(m.pedidos).toHaveLength(1);
  });
});

describe("bloco HTTP no motor — o que a resposta devolveu não vai ao evento", () => {
  it("o effect_done guarda só os NOMES; os valores ficam em enrollments.vars", async () => {
    const m = montar({ claimedUntilEmMs: 120_000 });
    await m.tick();
    const fim = m.eventos.find((e) => e.event_type === "effect_done");
    expect(fim).toBeDefined();
    expect(JSON.stringify(m.eventos)).not.toContain("Maria Silva");
    expect((fim!.payload!.detalhes as Array<{ campos?: string[] }>)[0]!.campos).toEqual(["pedido"]);
    expect((m.row.vars as { saida?: unknown }).saida).toEqual({ pedido: "PED-123 de Maria Silva" });
  });

  it("os valores vão a enrollments.vars num patch próprio, antes do passo (sobrevivem à queda entre o fim e o passo)", async () => {
    const m = montar({ claimedUntilEmMs: 120_000 });
    await m.tick();
    const varsGravadas = m.patches.find(
      (p) => p.vars && (p.vars as { saida?: unknown }).saida,
    )?.vars;
    expect(varsGravadas).toMatchObject({ saida: { pedido: "PED-123 de Maria Silva" } });
  });
});
