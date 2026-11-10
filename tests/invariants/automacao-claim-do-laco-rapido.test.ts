import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { isolarFixtureDeFollowup } from "./followup-isolamento";

/**
 * Migration 1003 — o claim do laço rápido das automações (lote 6).
 *
 * O worker chama `fn_claim_due_automacao_enrollments` a cada ~5 s e o cron
 * chama `fn_claim_due_followup_enrollments` a cada minuto. A propriedade que
 * importa é a de NÃO HAVER DUPLA EXECUÇÃO: os dois gravam o mesmo
 * `claimed_until`, e uma linha reclamada por um não volta pelo outro enquanto
 * o lease vale — inclusive com as chamadas simultâneas em conexões diferentes.
 * Só um Postgres de verdade responde isso (`for update skip locked` + a
 * condição de lease repetida no UPDATE).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 6,
});

afterAll(async () => {
  await isolarFixtureDeFollowup(pool);
  await pool.end();
});

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
});

const ORG = "f0000003-0000-4000-8000-00000000fb03";
const ORG_PARADA = "f0000004-0000-4000-8000-00000000fb04";

const GRAFO_MINIMO = JSON.stringify({
  nodes: [
    { id: "t1", type: "trigger", label: "i", position: { x: 0, y: 0 }, config: {} },
    {
      id: "e1",
      type: "end",
      label: "f",
      position: { x: 0, y: 0 },
      config: { outcome: "converted" },
    },
  ],
  edges: [{ id: "a", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
});

async function semearOrg(org: string, nome: string, status = "active"): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)
     on conflict (id) do nothing`,
    [org, `laco-rapido-${nome}`, nome],
  );
  await pool.query(`update organizations set status = $2 where id = $1`, [org, status]);
}

async function semearPointer(
  org: string,
  surface: "followup" | "automacao",
): Promise<{ pointerId: string; versionId: string }> {
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, GRAFO_MINIMO],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, surface)
     values ($1, $2, 'active', $3, $4) returning id`,
    [org, `Fluxo ${surface} ${Date.now()}-${Math.random()}`, v[0]!.id, surface],
  );
  return { pointerId: p[0]!.id, versionId: v[0]!.id };
}

/** `quantos` enrollments vencidos, um contato cada (a automação tem uma execução viva por contato). */
async function semearVencidos(
  org: string,
  ids: { pointerId: string; versionId: string },
  quantos: number,
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `with novos as (
       insert into contacts (organization_id, display_name)
       select $1, 'Lead ' || g from generate_series(1, $2::int) g
       returning id
     )
     insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
     select $1, $3, $4, novos.id, 't1', 'active', now() - interval '1 minute'
       from novos
     returning id`,
    [org, quantos, ids.pointerId, ids.versionId],
  );
  return rows.map((r) => r.id);
}

const claimAutomacao = async (limite = 20) =>
  (
    await pool.query<{ id: string; lane: string }>(
      `select id, lane from fn_claim_due_automacao_enrollments($1, 120)`,
      [limite],
    )
  ).rows;
const claimTodas = async (limite = 20) =>
  (
    await pool.query<{ id: string; lane: string }>(
      `select id, lane from fn_claim_due_followup_enrollments($1, 120)`,
      [limite],
    )
  ).rows;

describe("fn_claim_due_automacao_enrollments (migration 1003)", () => {
  it("reclama só a raia automacao, e o que ele reclamou o cron não pega de novo", async () => {
    await semearOrg(ORG, "ativa");
    const automacoes = await semearVencidos(ORG, await semearPointer(ORG, "automacao"), 3);
    const followups = await semearVencidos(ORG, await semearPointer(ORG, "followup"), 2);

    const doLaco = await claimAutomacao();
    expect(doLaco.map((r) => r.id).sort()).toEqual([...automacoes].sort());
    expect(new Set(doLaco.map((r) => r.lane))).toEqual(new Set(["automacao"]));

    // O cron, logo depois: só os follow-ups — as automações estão com lease.
    const doCron = await claimTodas();
    expect(doCron.map((r) => r.id).sort()).toEqual([...followups].sort());
    // E o laço de novo, no tick seguinte: nada (o lease ainda vale).
    expect(await claimAutomacao()).toHaveLength(0);
  });

  it("chamadas simultâneas (laço ×2 e cron) nunca devolvem a mesma execução", async () => {
    await semearOrg(ORG, "ativa");
    const automacoes = await semearVencidos(ORG, await semearPointer(ORG, "automacao"), 12);

    const [a, b, c] = await Promise.all([claimAutomacao(5), claimAutomacao(5), claimTodas(5)]);
    const todos = [...a, ...b, ...c].map((r) => r.id);
    expect(new Set(todos).size).toBe(todos.length); // sem interseção
    expect(todos.every((id) => automacoes.includes(id))).toBe(true);
    // Cada linha reclamada ficou com lease no futuro.
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from followup_enrollments where id = any($1::uuid[]) and claimed_until > now()`,
      [todos],
    );
    expect(rows[0]!.n).toBe(todos.length);
  });

  it("organização parada não é reclamada", async () => {
    await semearOrg(ORG_PARADA, "parada", "suspended");
    await semearVencidos(ORG_PARADA, await semearPointer(ORG_PARADA, "automacao"), 2);
    expect(await claimAutomacao()).toHaveLength(0);
  });

  it("só service_role executa (as duas origens de EXECUTE revogadas)", async () => {
    const { rows } = await pool.query<{ papel: string; pode: boolean }>(
      `select papel, has_function_privilege(papel, 'public.fn_claim_due_automacao_enrollments(int, int)', 'execute') as pode
         from unnest(array['anon', 'authenticated', 'service_role']) as papel`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.papel, r.pode]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });

  it("o índice parcial da raia existe, casa com o filtro da função e o planejador o usa", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'idx_followup_enrollments_due_automacao'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(/\(next_eval_at\)/);
    expect(def).toMatch(/lane = 'automacao'/);
    for (const status of ["active", "waiting_reply", "dormente"]) expect(def).toContain(`'${status}'`);

    // Com seqscan desligado o planejador só pode escolher o índice se o predicado
    // da consulta (a mesma que a função faz) implica o dele.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local enable_seqscan = off");
      const { rows: plano } = await c.query<{ "QUERY PLAN": string }>(
        `explain select id from followup_enrollments
          where lane = 'automacao' and status in ('active','waiting_reply','dormente')
            and next_eval_at <= now()`,
      );
      expect(plano.map((r) => r["QUERY PLAN"]).join("\n")).toContain("idx_followup_enrollments_due_automacao");
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("reaplicar o apêndice do baseline (update.sh) não quebra e a função segue servindo o claim", async () => {
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const inicio = baseline.indexOf("-- ---- o claim das automações para o laço rápido do worker (migration 1003");
    expect(inicio).toBeGreaterThan(0);
    const fim = baseline.indexOf("-- ---- VARREDURA anon", inicio);
    expect(fim).toBeGreaterThan(inicio);
    const bloco = baseline.slice(inicio, fim);

    await pool.query(bloco);
    await pool.query(bloco); // duas vezes: idempotente

    await semearOrg(ORG, "ativa");
    const automacoes = await semearVencidos(ORG, await semearPointer(ORG, "automacao"), 2);
    expect((await claimAutomacao()).map((r) => r.id).sort()).toEqual([...automacoes].sort());
  });
});
