import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { runFollowupTick, type ExecutorDeEfeitos, type PedidoDeEfeito, type TickDeps } from "@/lib/followup/engine";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import { MAX_VISITAS_POR_NO } from "@/lib/automacoes/schemas";

import { isolarFixtureDeFollowup } from "./followup-isolamento";

/**
 * O MOTOR na raia `automacao` (0986), contra Postgres real e o adaptador `pg`
 * de produção dos invariantes (`createPgAdminClient`, que grava pelo
 * `fn_followup_patch` — o CAS de verdade).
 *
 * O executor de efeitos aqui é um dublê que ESCREVE no banco (acrescenta uma
 * tag ao contato) e conta as chamadas: é ele que prova "o efeito não roda duas
 * vezes". O que está sob prova é o motor, não o efeito — os efeitos reais
 * passam pelos handlers da API (`lib/automacoes/efeitos`), cobertos pela prova
 * pela tela e pelo e2e.
 *
 *  1. blocos instantâneos andam em sequência no MESMO tick até o Fim;
 *  2. as variáveis que o efeito devolve persistem (`vars`) e a condição seguinte as lê;
 *  3. replay: com `effect_done` já gravado, o efeito NÃO roda de novo;
 *  4. interrompido: só `effect_started` → o bloco sai por "Erro", sem repetir;
 *  5. o teto de visitas por bloco mata o laço.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via scripts/test-db.sh");
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 4 });
afterAll(async () => {
  await pool.end();
});

const ORG = "0986cccc-0000-4000-8000-000000000001";

function no(id: string, type: string, config: unknown, y = 0) {
  return { id, type, label: id, position: { x: 0, y }, config } as FlowGraph["nodes"][number];
}
function aresta(id: string, source: string, target: string, condition: FlowGraph["edges"][number]["condition"] = { type: "always" }) {
  return { id, source, target, priority: 0, condition };
}
const INICIO = no("t", "trigger", { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } });
const ACAO = no("a", "crm_action", { actions: [{ type: "add_tags", target: "contact", tags: ["X"] }], on_error: "route" }, 100);

/** Dublê de efeito: grava uma tag no contato e devolve uma variável — conta as chamadas. */
function executorContando(): ExecutorDeEfeitos & { chamadas: PedidoDeEfeito[] } {
  const chamadas: PedidoDeEfeito[] = [];
  return {
    chamadas,
    async executar(pedido) {
      chamadas.push(pedido);
      await pool.query(
        `update contacts set tags = array_append(tags, $3) where organization_id = $1 and id = $2`,
        [pedido.enrollment.organization_id, pedido.enrollment.contact_id, `efeito-${chamadas.length}`],
      );
      return { desfecho: { ok: true }, vars: { marcador: "sim" }, detalhes: [{ tipo: "teste" }] };
    },
  };
}

function deps(efeitos: ExecutorDeEfeitos): TickDeps {
  return { db: createPgAdminClient(pool), clock: () => new Date(), enqueueJob: async () => undefined, efeitos };
}

async function semear(graph: FlowGraph): Promise<{ pointer: string; versao: string; contato: string }> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, 'inv-0986-eng', 'Inv 0986 Eng', 'Inv 0986 Eng') on conflict do nothing`,
    [ORG],
  );
  const { rows: c } = await pool.query(`insert into contacts (organization_id, display_name) values ($1, 'Contato motor') returning id`, [ORG]);
  const { rows: v } = await pool.query(`insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`, [
    ORG,
    JSON.stringify(graph),
  ]);
  const { rows: p } = await pool.query(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, surface)
     values ($1, $2, 'active', $3, 'automacao') returning id`,
    [ORG, `Motor ${Math.random()}`, v[0].id],
  );
  return { pointer: p[0].id, versao: v[0].id, contato: c[0].id };
}

async function iniciar(pointer: string, contato: string): Promise<string> {
  const { rows } = await pool.query(
    `select (public.fn_automacao_iniciar($1, $2, $3, '{"gatilho":{"tipo":"manual"}}'::jsonb, null, null))->>'enrollment_id' as id`,
    [ORG, pointer, contato],
  );
  // O default do banco é now(); o claim compara com now() do Postgres — recua 1 s para vencer já.
  await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [rows[0].id]);
  return rows[0].id;
}

async function inscricao(id: string) {
  const { rows } = await pool.query(`select * from followup_enrollments where id = $1`, [id]);
  return rows[0];
}
async function eventos(id: string): Promise<Array<{ node_id: string; event_type: string; idempotency_key: string }>> {
  const { rows } = await pool.query(
    `select node_id, event_type, idempotency_key from followup_enrollment_events where enrollment_id = $1 order by created_at, id`,
    [id],
  );
  return rows;
}

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
});

describe("motor na raia automacao", () => {
  it("anda em sequência no mesmo tick até o Fim, roda o efeito uma vez e guarda as variáveis", async () => {
    const grafo: FlowGraph = {
      nodes: [
        INICIO,
        ACAO,
        no("c", "condition", {
          combinator: "and",
          branching: "per_check",
          checks: [{ id: "tem", kind: "field", field: { scope: "var", path: "gatilho.tipo" }, op: "eq", value: "manual" }],
        }, 200),
        no("fim", "end", { outcome: "converted" }, 300),
        no("fim2", "end", { outcome: "exhausted" }, 300),
      ],
      edges: [
        aresta("e1", "t", "a"),
        aresta("e2", "a", "c"),
        aresta("e3", "c", "fim", { type: "branch", branch_id: "tem" }),
        aresta("e4", "c", "fim2"),
      ],
    };
    const s = await semear(grafo);
    const id = await iniciar(s.pointer, s.contato);
    const exec = executorContando();
    const resumo = await runFollowupTick(deps(exec));
    expect(resumo.claimed).toBe(1);

    const e = await inscricao(id);
    expect(e.lane).toBe("automacao");
    expect(e.status).toBe("completed");
    expect(e.outcome).toBe("converted"); // a condição leu vars.gatilho.tipo
    expect(e.vars.marcador).toBe("sim");
    expect(exec.chamadas).toHaveLength(1);
    const tipos = (await eventos(id)).map((x) => x.event_type);
    expect(tipos).toEqual(["automacao_iniciada", "node_advanced", "effect_started", "effect_done", "node_advanced", "node_advanced", "flow_completed"]);
    const { rows } = await pool.query(`select tags from contacts where id = $1`, [s.contato]);
    expect(rows[0].tags).toEqual(["efeito-1"]);
  });

  it("replay: com effect_done já gravado, o efeito não roda de novo e o bloco avança", async () => {
    const s = await semear({
      nodes: [INICIO, ACAO, no("fim", "end", { outcome: "converted" }, 200)],
      edges: [aresta("e1", "t", "a"), aresta("e2", "a", "fim")],
    });
    const id = await iniciar(s.pointer, s.contato);
    await pool.query(`update followup_enrollments set current_node_id = 'a', steps_taken = 3 where id = $1`, [id]);
    await pool.query(
      `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
       values ($1, $2, 'a', 'effect_done', '{"desfecho":{"ok":true},"vars":{"_lead_id":"x"}}', 'a:3:efeito_fim')`,
      [ORG, id],
    );
    const exec = executorContando();
    await runFollowupTick(deps(exec));
    const e = await inscricao(id);
    expect(exec.chamadas).toHaveLength(0);
    expect(e.status).toBe("completed");
    expect(e.vars._lead_id).toBe("x");
  });

  it("interrompido no meio (só effect_started): sai por Erro e não repete o efeito", async () => {
    const s = await semear({
      nodes: [INICIO, ACAO, no("ok", "end", { outcome: "converted" }, 200), no("erro", "end", { outcome: "exhausted" }, 200)],
      edges: [aresta("e1", "t", "a"), aresta("e2", "a", "ok"), aresta("e3", "a", "erro", { type: "branch", branch_id: "erro" })],
    });
    const id = await iniciar(s.pointer, s.contato);
    await pool.query(`update followup_enrollments set current_node_id = 'a', steps_taken = 2 where id = $1`, [id]);
    await pool.query(
      `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
       values ($1, $2, 'a', 'effect_started', '{}', 'a:2:efeito_inicio')`,
      [ORG, id],
    );
    const exec = executorContando();
    await runFollowupTick(deps(exec));
    const e = await inscricao(id);
    expect(exec.chamadas).toHaveLength(0);
    expect(e.status).toBe("completed");
    expect(e.outcome).toBe("exhausted");
    expect((await eventos(id)).some((x) => x.event_type === "effect_failed")).toBe(true);
  });

  it("o teto de visitas por bloco encerra o laço como 'dead'", async () => {
    const s = await semear({
      nodes: [
        INICIO,
        ACAO,
        no("c", "condition", { combinator: "and", checks: [{ kind: "deal_exists" }] }, 200),
        no("fim", "end", { outcome: "converted" }, 300),
      ],
      // Sem negócio, a condição é sempre "Não" e volta para a ação: laço sem espera.
      edges: [
        aresta("e1", "t", "a"),
        aresta("e2", "a", "c"),
        aresta("e3", "c", "fim", { type: "cond_result", value: true }),
        aresta("e4", "c", "a", { type: "cond_result", value: false }),
      ],
    });
    const id = await iniciar(s.pointer, s.contato);
    const exec = executorContando();
    for (let i = 0; i < 10; i++) {
      await runFollowupTick(deps(exec));
      const e = await inscricao(id);
      if (e.status === "dead") break;
      await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second', claimed_until = null where id = $1`, [id]);
    }
    const e = await inscricao(id);
    expect(e.status).toBe("dead");
    expect(e.cancel_reason).toBe("visitas_por_no");
    expect(exec.chamadas.length).toBeLessThanOrEqual(MAX_VISITAS_POR_NO);
  });
});
