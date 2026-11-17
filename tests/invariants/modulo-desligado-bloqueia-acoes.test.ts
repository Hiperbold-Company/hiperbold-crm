/**
 * MÓDULO DESLIGADO NÃO ACEITA AÇÃO, NEM PELA REST — migration 1016.
 *
 * Desligar um módulo esconde as telas no app, mas as RPCs que mudam dados do módulo estão expostas a
 * `authenticated`: sem uma checagem no banco, quem tem a sessão as chamaria direto pelo PostgREST.
 * `fn_finalizar_comanda`, `fn_estornar_comanda` e `fn_honorarios_parcela_pagar` começam por
 * `fn_modulo_exigir_ativo`, que lança `modulo_inativo` (errcode PT423) quando o módulo está registrado
 * e não está `ativo`. Este arquivo mede: a forma do helper; a recusa nas três RPCs com o módulo
 * desligado; e, em honorários, que a parcela não é paga desligado e é paga depois de religar.
 * E as tabelas do módulo têm policies RESTRITIVAS de escrita (`modulo_ativo_insert|update|delete`,
 * com `fn_modulo_esta_ativo`): desligado, a escrita direta pela sessão é recusada e a leitura segue.
 */
import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const query = (text: string, values: unknown[] = []) => pool.query(text, values);

const ORG = "e1016b00-0000-4000-8000-0000000000a1";
const GERENTE = "e1016b00-1111-4000-8000-000000000001";
const CONTA = "e1016b00-2222-4000-8000-000000000001";
const CONTRATO = "e1016b00-3333-4000-8000-000000000001";
const PARCELA = "e1016b00-4444-4000-8000-000000000001";

/** Roda `sql` como o gerente logado (papel `authenticated`), numa transação desfeita no fim. */
async function comoGerente(sql: string, valores: unknown[]): Promise<Record<string, unknown>> {
  const c: PoolClient = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: GERENTE, role: "authenticated" }),
    ]);
    const r = await c.query(sql, valores);
    await c.query("commit");
    return r.rows[0];
  } catch (erro) {
    await c.query("rollback");
    throw erro;
  } finally {
    c.release();
  }
}

async function recusa(promessa: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promessa;
  } catch (erro) {
    return erro as { code?: string; message?: string };
  }
  throw new Error("a chamada deveria ter sido recusada");
}

const definirEstado = (modulo: string, estado: string) =>
  query(
    `insert into public.modulos_instalados (modulo, estado) values ($1, $2)
       on conflict (modulo) do update set estado = excluded.estado`,
    [modulo, estado],
  );

const pagar = () =>
  comoGerente("select public.fn_honorarios_parcela_pagar($1, $2, $3) as r", [ORG, PARCELA, CONTA]);

async function statusDaParcela(): Promise<string> {
  return (await query("select status from public.honorarios_parcelas where id = $1", [PARCELA])).rows[0].status;
}

beforeAll(async () => {
  await query("select public.fn_honorarios_provisionar()");
  await query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [
    GERENTE,
    "modulo-desligado-acoes@invariant.test",
  ]);
  await query(
    "insert into public.organizations (id, slug, legal_name, display_name) values ($1, 'org-1016-acoes', 'Org 1016 Acoes', 'Org 1016 Acoes') on conflict (id) do nothing",
    [ORG],
  );
  await query(
    "insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ($1, $2, 'manager', now()) on conflict do nothing",
    [GERENTE, ORG],
  );
  await query("insert into public.financial_accounts (id, organization_id, name) values ($1, $2, 'Caixa') on conflict (id) do nothing", [
    CONTA,
    ORG,
  ]);
  await query(
    "insert into public.honorarios_contratos (id, organization_id, modelo, valor_fixo_cents) values ($1, $2, 'fixo', 100000) on conflict (id) do nothing",
    [CONTRATO, ORG],
  );
  await query(
    "insert into public.honorarios_parcelas (id, organization_id, contrato_id, numero, vencimento, valor_cents) values ($1, $2, $3, 1, '2026-12-01', 100000) on conflict (id) do nothing",
    [PARCELA, ORG, CONTRATO],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("o helper", () => {
  it("fn_modulo_exigir_ativo é stable security definer, com pg_temp no search_path, de nenhum papel do PostgREST", async () => {
    const r = await query(`
      select p.prosecdef, p.provolatile,
             exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%pg_temp%') as pg_temp,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fn_modulo_exigir_ativo'`);
    expect(r.rows).toEqual([{ prosecdef: true, provolatile: "s", pg_temp: true, anon: false, authenticated: false }]);
  });

  it("as três RPCs mutantes de módulo expostas a authenticated chamam o helper", async () => {
    const r = await query(`
      select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             position('fn_modulo_exigir_ativo' in p.prosrc) > 0 as checa
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('fn_finalizar_comanda', 'fn_estornar_comanda', 'fn_honorarios_parcela_pagar')
       order by p.proname`);
    expect(r.rows).toEqual([
      { proname: "fn_estornar_comanda", authenticated: true, checa: true },
      { proname: "fn_finalizar_comanda", authenticated: true, checa: true },
      { proname: "fn_honorarios_parcela_pagar", authenticated: true, checa: true },
    ]);
  });
});

describe("a trava de escrita nas tabelas do módulo", () => {
  it("fn_modulo_esta_ativo é stable security definer, não lança, e authenticated a executa (as policies precisam)", async () => {
    const r = await query(`
      select p.prosecdef, p.provolatile, p.prorettype = 'boolean'::regtype as booleana,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fn_modulo_esta_ativo'`);
    expect(r.rows).toEqual([{ prosecdef: true, provolatile: "s", booleana: true, anon: false, authenticated: true }]);
    expect((await query("select public.fn_modulo_esta_ativo('sem_registro') as v")).rows[0].v).toBe(true);
  });

  it("as tabelas de honorários têm as três policies restritivas de escrita, e nenhuma de leitura", async () => {
    const r = await query(`
      select tablename, policyname, permissive, cmd from pg_policies
       where schemaname = 'public' and tablename in ('honorarios_contratos', 'honorarios_parcelas')
         and policyname like 'modulo_ativo_%'
       order by tablename, policyname`);
    expect(r.rows).toEqual(
      ["honorarios_contratos", "honorarios_parcelas"].flatMap((tablename) => [
        { tablename, policyname: "modulo_ativo_delete", permissive: "RESTRICTIVE", cmd: "DELETE" },
        { tablename, policyname: "modulo_ativo_insert", permissive: "RESTRICTIVE", cmd: "INSERT" },
        { tablename, policyname: "modulo_ativo_update", permissive: "RESTRICTIVE", cmd: "UPDATE" },
      ]),
    );
  });
});

describe("desligado não aceita ação", () => {
  it("comanda: finalizar e estornar são recusados com PT423 quando o financeiro está desligado", async () => {
    await definirEstado("financeiro", "desligado");
    const finalizar = await recusa(
      comoGerente("select public.fn_finalizar_comanda($1, $2, $3) as r", [ORG, randomUUID(), randomUUID()]),
    );
    expect(finalizar).toMatchObject({ code: "PT423", message: "modulo_inativo" });
    const estornar = await recusa(
      comoGerente("select public.fn_estornar_comanda($1, $2, $3) as r", [ORG, randomUUID(), "teste"]),
    );
    expect(estornar).toMatchObject({ code: "PT423", message: "modulo_inativo" });
  });

  it("suspenso também recusa", async () => {
    await definirEstado("financeiro", "suspenso");
    const finalizar = await recusa(
      comoGerente("select public.fn_finalizar_comanda($1, $2, $3) as r", [ORG, randomUUID(), randomUUID()]),
    );
    expect(finalizar).toMatchObject({ code: "PT423" });
  });

  it("honorários desligado: pagar é recusado e a parcela continua pendente", async () => {
    await definirEstado("honorarios", "desligado");
    expect(await recusa(pagar())).toMatchObject({ code: "PT423", message: "modulo_inativo" });
    expect(await statusDaParcela()).toBe("pendente");
  });

  it("honorários desligado: escrita direta pela sessão é recusada pela RLS; a leitura segue", async () => {
    const insercao = await recusa(
      comoGerente(
        "insert into public.honorarios_contratos (organization_id, modelo, valor_fixo_cents) values ($1, 'fixo', 1) returning id",
        [ORG],
      ),
    );
    expect(insercao).toMatchObject({ code: "42501" });
    const alterou = await comoGerente(
      "with u as (update public.honorarios_parcelas set valor_cents = 1 where id = $1 returning 1) select count(*)::int as n from u",
      [PARCELA],
    );
    expect(alterou.n).toBe(0);
    const lida = await comoGerente("select count(*)::int as n from public.honorarios_parcelas where id = $1", [PARCELA]);
    expect(lida.n).toBe(1);
  });

  it("honorários religado: a mesma parcela é paga", async () => {
    await definirEstado("honorarios", "ativo");
    const r = await pagar();
    expect(r.r).toMatchObject({ id: PARCELA, status: "pago" });
    expect(await statusDaParcela()).toBe("pago");
  });
});
