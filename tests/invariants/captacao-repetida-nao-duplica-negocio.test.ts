/**
 * Captação repetida não duplica negócio (migration 0977).
 *
 * Medido em produção (27/10/2026, CBEXS): clique duplo no formulário do site,
 * dois envios em 1 s com external_id diferentes, dois negócios abertos no mesmo
 * funil. O gatilho `trg_crm_leads_captacao_repetida` serializa o INSERT da
 * captação por (organização, contato, funil) e recusa o segundo negócio quando
 * já há um aberto do contato no funil criado há até 10 minutos.
 *
 * Prova, no banco que o kit instala:
 *  1. segundo negócio da captação dentro da janela -> PT409;
 *  2. negócio aberto há mais de 10 min -> o novo entra;
 *  3. outro funil -> entra;
 *  4. negócio ganho/perdido -> entra;
 *  5. o que não é captação (sem webhook_source_id, clone, sem contato) -> entra;
 *  6. dois INSERTs CONCORRENTES em conexões separadas -> exatamente 1 negócio;
 *  7. a função não é executável por anon/authenticated.
 *
 * Namespace de fixtures 'ffffffff-e977-*'.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const ORG = "ffffffff-e977-4000-8000-000000000001";
const PIPE = "ffffffff-e977-4000-8000-000000000101";
const STAGE = "ffffffff-e977-4000-8000-000000000201";
const PIPE_2 = "ffffffff-e977-4000-8000-000000000102";
const STAGE_2 = "ffffffff-e977-4000-8000-000000000202";
const FONTE = "ffffffff-e977-4000-8000-000000000301";

let seqContato = 0;
function contatoNovo(): string {
  seqContato += 1;
  const id = `ffffffff-e977-4000-8000-${String(400000000000 + seqContato)}`;
  sql(`insert into public.contacts (id, organization_id, name) values ('${id}', '${ORG}', 'Contato ${seqContato}');`);
  return id;
}

function insertCaptacao(
  contato: string | null,
  opts: { pipe?: string; stage?: string; meta?: string; source?: string; status?: string; criadoHa?: string } = {},
): string {
  const meta = opts.meta ?? `{"webhook_source_id":"${FONTE}"}`;
  const criado = opts.criadoHa ? `now() - interval '${opts.criadoHa}'` : "now()";
  return `insert into public.crm_leads
    (organization_id, pipeline_id, stage_id, title, status, position_in_stage, source, source_metadata, contact_id, created_at, closed_at, lost_reason)
    values ('${ORG}', '${opts.pipe ?? PIPE}', '${opts.stage ?? STAGE}', 'captacao', '${opts.status ?? "open"}', 1000,
            '${opts.source ?? "webhook"}', '${meta}'::jsonb, ${contato ? `'${contato}'` : "null"}, ${criado},
            ${(opts.status ?? "open") === "open" ? "null" : "now()"},
            ${opts.status === "lost" ? "'other'" : "null"});`;
}

function contar(contato: string): number {
  return Number(sql(`select count(*) from public.crm_leads where organization_id='${ORG}' and contact_id='${contato}';`));
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-captacao-repetida', 'Captacao Repetida', 'Captacao Repetida')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE}', '${ORG}', 'Funil 1', 'cr-funil-1'),
      ('${PIPE_2}', '${ORG}', 'Funil 2', 'cr-funil-2')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE}', '${ORG}', '${PIPE}', 'Novo', 'novo', 1),
      ('${STAGE_2}', '${ORG}', '${PIPE_2}', 'Novo', 'novo', 1)
      on conflict do nothing;
  `);
});
afterAll(() => pool.end());

describe("trg_crm_leads_captacao_repetida", () => {
  it("1. segundo negócio da captação dentro de 10 min é recusado com PT409", () => {
    const c = contatoNovo();
    sql(insertCaptacao(c));
    expect(() => sql(insertCaptacao(c))).toThrowError(/captacao_repetida_na_janela/);
    expect(contar(c)).toBe(1);
  });

  it("2. negócio aberto há mais de 10 min não segura o novo", () => {
    const c = contatoNovo();
    sql(insertCaptacao(c, { meta: "{}", source: "manual", criadoHa: "11 minutes" }));
    sql(insertCaptacao(c));
    expect(contar(c)).toBe(2);
  });

  it("3. outro funil não segura", () => {
    const c = contatoNovo();
    sql(insertCaptacao(c, { pipe: PIPE_2, stage: STAGE_2 }));
    sql(insertCaptacao(c));
    expect(contar(c)).toBe(2);
  });

  it("4. negócio ganho ou perdido não segura", () => {
    const c = contatoNovo();
    sql(insertCaptacao(c, { status: "won" }));
    sql(insertCaptacao(c, { status: "lost" }));
    sql(insertCaptacao(c));
    expect(contar(c)).toBe(3);
  });

  it("5. o que não é captação pública passa (sem fonte, clone, sem contato)", () => {
    const c = contatoNovo();
    sql(insertCaptacao(c));
    sql(insertCaptacao(c, { meta: "{}" }));
    sql(insertCaptacao(c, { meta: `{"webhook_source_id":"${FONTE}","clonado_de":{"lead_id":"x"}}` }));
    sql(insertCaptacao(c, { source: "manual" }));
    expect(contar(c)).toBe(4);
    sql(insertCaptacao(null));
    sql(insertCaptacao(null));
  });

  it("6. dois INSERTs concorrentes do mesmo contato no mesmo funil resultam em 1 negócio", async () => {
    const c = contatoNovo();
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      // A segura a transação aberta com o INSERT feito; B tenta no meio.
      await a.query("begin");
      await a.query(insertCaptacao(c));
      const pidB = (await b.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const tentativaB = b.query(insertCaptacao(c)).then(
        () => "entrou" as const,
        (e: { code?: string; message?: string }) => `${e.code}:${e.message}`,
      );

      let esperando = false;
      for (let i = 0; i < 200 && !esperando; i++) {
        const r = await pool.query("select wait_event_type = 'Lock' as w from pg_stat_activity where pid = $1", [pidB]);
        esperando = r.rows[0]?.w === true;
        if (!esperando) await pool.query("select pg_sleep(0.01)");
      }
      expect(esperando).toBe(true);

      await a.query("commit");
      expect(await tentativaB).toBe("PT409:captacao_repetida_na_janela");
      expect(contar(c)).toBe(1);
    } finally {
      await a.query("rollback").catch(() => {});
      a.release();
      b.release();
    }
  });

  it("7. a função não é executável por anon nem authenticated", () => {
    const out = sql(`
      select has_function_privilege('anon', 'public.fn_crm_leads_captacao_repetida()', 'execute')::text
        || ',' || has_function_privilege('authenticated', 'public.fn_crm_leads_captacao_repetida()', 'execute')::text;
    `);
    expect(out).toBe("false,false");
  });
});
