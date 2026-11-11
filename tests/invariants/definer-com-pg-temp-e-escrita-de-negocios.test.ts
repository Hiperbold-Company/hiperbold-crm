/**
 * Três cercas de banco do lote de 11/11/2026 (fork Hiperbold), medidas em Postgres REAL.
 *
 * D-221 · suporte só-leitura não escreve em negócios. As policies de INSERT, UPDATE e DELETE de
 *   `crm_leads` (reescritas pela 0975/0976 com `fn_is_platform_admin()`) foram levadas a
 *   `fn_is_platform_admin_full()` pela varredura da 0992 (`$hb_0992_full$`), que roda depois delas
 *   no baseline e na cadeia. Este arquivo prova o COMPORTAMENTO nas três operações: o admin de
 *   plataforma `support_readonly` alcança 0 linhas, o `full` alcança 1. A conta global (nenhuma
 *   policy de escrita de `public` com a função pura) já é cobrada em
 *   `platform-admin-full-so-escreve.test.ts` ("CONTA GLOBAL"); aqui ela é repetida com o recorte
 *   explícito INSERT/UPDATE/DELETE/ALL e a lista de quem falha, para o vermelho dizer onde.
 *   Previsão (sabotagem): voltar `crm_leads_delete` para a função pura deixa o caso DELETE em 1.
 *
 * D-222 · gerente de duas organizações não move negócio de uma para a outra. O gatilho
 *   `trg_billing_trava_organization_id_crm_leads` (0907) recusa a troca de `organization_id` fora do
 *   servidor. `planos-bloqueio-membros.test.ts` cobre o ADMIN das duas; aqui é o GERENTE (manager),
 *   que passa na RLS das duas organizações, e a prova inclui que a linha não mudou.
 *
 * D-223 · toda security definer de `public` termina o search_path com `pg_temp` (migration 1008).
 *   Previsão (sabotagem): tirar o bloco 1008 do fim do baseline deixa o caso de catálogo com ~200.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

const ORG_A = "d1008000-0000-4000-8000-000000000001";
const ORG_B = "d1008000-0000-4000-8000-000000000002";
const FULL = "d1008000-1111-4000-8000-000000000001";
const READONLY = "d1008000-1111-4000-8000-000000000002";
const GERENTE = "d1008000-1111-4000-8000-000000000003";
const PIPELINE_A = "d1008000-2222-4000-8000-000000000001";
const STAGE_A = "d1008000-2222-4000-8000-000000000002";
const LEAD = "d1008000-3333-4000-8000-000000000001";
const LEAD_APAGAR = "d1008000-3333-4000-8000-000000000002";
const LEAD_GERENTE = "d1008000-3333-4000-8000-000000000003";
const LEAD_NOVO_RO = "d1008000-3333-4000-8000-000000000004";
const LEAD_NOVO_FULL = "d1008000-3333-4000-8000-000000000005";

function erroDe(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-1008-a', 'Org 1008 A', 'Org 1008 A'),
      ('${ORG_B}', 'inv-1008-b', 'Org 1008 B', 'Org 1008 B')
      on conflict (id) do nothing;
    insert into auth.users (id, email) values
      ('${FULL}', 'full-1008@invariant.test'),
      ('${READONLY}', 'readonly-1008@invariant.test'),
      ('${GERENTE}', 'gerente-1008@invariant.test')
      on conflict (id) do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${FULL}', '${FULL}', 'full', false, 'invariante 1008'),
      ('${READONLY}', '${FULL}', 'support_readonly', false, 'invariante 1008')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GERENTE}', '${ORG_A}', 'manager', now()),
      ('${GERENTE}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE_A}', '${ORG_A}', 'Funil 1008', 'funil-1008')
      on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_A}', '${ORG_A}', '${PIPELINE_A}', 'Novo', 'novo-1008', 1000)
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title) values
      ('${LEAD}', '${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', 'Lead 1008'),
      ('${LEAD_APAGAR}', '${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', 'Lead 1008 apagar'),
      ('${LEAD_GERENTE}', '${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', 'Lead 1008 gerente')
      on conflict (id) do nothing;
  `);
});

describe("D-221 · support_readonly não escreve em crm_leads; o full escreve", () => {
  const insert = (id: string) =>
    `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
       values ('${id}', '${ORG_A}', '${PIPELINE_A}', '${STAGE_A}', 'sonda 1008')`;

  it("support_readonly continua LENDO o negócio (a leitura não muda)", () => {
    expect(countAs(READONLY, `select count(*) from public.crm_leads where id = '${LEAD}';`)).toBe(1);
  });

  it("INSERT: 0 como support_readonly; 1 como full", () => {
    expect(writeCountAs(READONLY, insert(LEAD_NOVO_RO))).toBe(0);
    expect(writeCountAs(FULL, insert(LEAD_NOVO_FULL))).toBe(1);
    expect(sql(`select count(*) from public.crm_leads where id = '${LEAD_NOVO_RO}';`)).toBe("0");
  });

  it("UPDATE: 0 como support_readonly; 1 como full", () => {
    expect(writeCountAs(READONLY, `update public.crm_leads set title = 'hackeado' where id = '${LEAD}'`)).toBe(0);
    expect(sql(`select title from public.crm_leads where id = '${LEAD}';`)).toBe("Lead 1008");
    expect(writeCountAs(FULL, `update public.crm_leads set title = 'escrito pelo full' where id = '${LEAD}'`)).toBe(1);
  });

  it("DELETE: 0 como support_readonly; 1 como full", () => {
    expect(writeCountAs(READONLY, `delete from public.crm_leads where id = '${LEAD_APAGAR}'`)).toBe(0);
    expect(sql(`select count(*) from public.crm_leads where id = '${LEAD_APAGAR}';`)).toBe("1");
    expect(writeCountAs(FULL, `delete from public.crm_leads where id = '${LEAD_APAGAR}'`)).toBe(1);
  });

  it("catálogo: nenhuma policy de INSERT/UPDATE/DELETE/ALL de public chama fn_is_platform_admin() sem _full", () => {
    const vazamentos = sql(`
      select coalesce(string_agg(tablename || '.' || policyname || ' (' || cmd || ')', ', ' order by 1), '')
        from pg_policies
       where schemaname = 'public'
         and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
         and (coalesce(qual, '') ~ 'fn_is_platform_admin\\(' or coalesce(with_check, '') ~ 'fn_is_platform_admin\\(');
    `);
    expect(vazamentos, "policy de escrita aceitando o suporte só-leitura").toBe("");
  });

  it("controle do catálogo: as três policies de escrita de crm_leads existem e usam _full", () => {
    const n = sql(`
      select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'crm_leads'
         and policyname in ('crm_leads_insert', 'crm_leads_update', 'crm_leads_delete')
         and (coalesce(qual, '') || coalesce(with_check, '')) like '%fn_is_platform_admin_full()%';
    `);
    expect(n).toBe("3");
  });
});

describe("D-222 · gerente de duas organizações não move negócio entre elas", () => {
  it("controle: o mesmo gerente edita o negócio na organização dele (a RLS deixa passar)", () => {
    expect(
      writeCountAs(GERENTE, `update public.crm_leads set title = 'editado pelo gerente' where id = '${LEAD_GERENTE}'`),
    ).toBe(1);
  });

  it("trocar organization_id para a outra organização é recusado pelo gatilho, e a linha não muda", () => {
    const erro = erroDe(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GERENTE}"}', false);
      update public.crm_leads set organization_id = '${ORG_B}' where id = '${LEAD_GERENTE}';
    `);
    expect(erro, "o gerente conseguiu mover o negócio de organização").not.toBeNull();
    expect(erro).toContain("organization_id só pode ser alterado pelo servidor");
    expect(sql(`select organization_id from public.crm_leads where id = '${LEAD_GERENTE}';`)).toBe(ORG_A);
  });
});

describe("D-223 · toda security definer de public termina o search_path com pg_temp", () => {
  const SEM_PG_TEMP_NO_FIM = `
    select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by 1), '')
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and coalesce(
             (select lower(btrim(btrim((string_to_array(substr(c, 13), ','))[cardinality(string_to_array(substr(c, 13), ','))]), '"'))
                from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%'),
             '') <> 'pg_temp';
  `;

  it("guarda de vacuidade: há centenas de definer em public para medir", () => {
    const n = Number(
      sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosecdef;`),
    );
    expect(n).toBeGreaterThan(100);
  });

  it("nenhuma definer de public fica sem pg_temp no fim do search_path", () => {
    expect(sql(SEM_PG_TEMP_NO_FIM), "definer sem pg_temp no fim do search_path").toBe("");
  });

  it("controle negativo: a sonda enxerga uma definer nova com search_path = public", () => {
    const out = sql(`
      begin;
      create function public.fn_sonda_1008() returns int language sql security definer
        set search_path = public as $$ select 1 $$;
      ${SEM_PG_TEMP_NO_FIM}
      rollback;
    `);
    expect(out).toContain("fn_sonda_1008()");
  });

  it("a varredura da 1008 cura a definer nova e reaplicada não muda nada", () => {
    const migration = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20261111140000_1008_definer_com_pg_temp_no_search_path.sql"),
      "utf8",
    );
    const retrato = `select md5(string_agg(p.oid::regprocedure::text || '=' || coalesce(array_to_string(p.proconfig, ','), '-'), ';' order by 1))
                       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef;`;
    const antes = sql(retrato);
    sql(migration);
    expect(sql(retrato), "reaplicar a 1008 mudou o search_path de alguma definer").toBe(antes);

    const out = sql(`
      begin;
      create function public.fn_sonda_1008b() returns int language sql security definer
        set search_path = public as $$ select 1 $$;
      create function public.fn_sonda_1008c() returns int language sql security definer
        set search_path = '' as $$ select 1 $$;
      create function public.fn_sonda_1008d() returns int language sql security definer as $$ select 1 $$;
      ${migration}
      select 'SONDA|' || p.proname || '|' || array_to_string(p.proconfig, ',')
        from pg_proc p where p.proname in ('fn_sonda_1008b', 'fn_sonda_1008c', 'fn_sonda_1008d') order by p.proname;
      rollback;
    `);
    const linhas = out.split("\n").filter((l) => l.startsWith("SONDA|"));
    expect(linhas).toEqual([
      "SONDA|fn_sonda_1008b|search_path=public, pg_temp",
      "SONDA|fn_sonda_1008c|search_path=pg_temp",
      "SONDA|fn_sonda_1008d|search_path=public, pg_temp",
    ]);
  });

  it("no baseline, nenhuma função é criada depois do bloco da 1008", () => {
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const marcador = baseline.lastIndexOf("(migration 1008, fork Hiperbold, D-223) ----");
    expect(marcador, "bloco da 1008 não encontrado no baseline").toBeGreaterThan(0);
    const depois = baseline.slice(marcador);
    expect(depois).toMatch(/\$hb_1008_definer_pg_temp\$;\s*$/);
    expect(depois).not.toMatch(/^[ \t]*create[ \t]+(?:or[ \t]+replace[ \t]+)?(?:function|procedure)/im);
  });
});
