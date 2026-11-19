/**
 * CONTATO COM NEGÓCIO EM ABERTO NÃO SAI — A REGRA MORA NO BANCO (migration 1019).
 *
 * A regra do dono do produto (19/11/2026) já existia no TypeScript, mas a RPC
 * (`fn_apagar_contato_com_historico`, `fn_excluir_contatos_em_lote`) e o
 * `DELETE /rest/v1/contacts` direto passavam por cima. O gatilho
 * `trg_contato_com_negocio_aberto_nao_sai` recusa em qualquer caminho, com o
 * errcode próprio `HB409`.
 *
 * Mede:
 *  (a) o gatilho barra: DELETE direto e a RPC de uma linha, inclusive quando o
 *      negócio é de OUTRO dono (o que a RLS do `agent` esconderia);
 *  (b) negócio ganho ou perdido não barra;
 *  (c) excluir a organização inteira continua funcionando (a cascata não é
 *      travada pelo gatilho);
 *  (d) o lote pula, sem abortar, o contato com negócio aberto.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "10191019-0000-4000-8000-000000000001";
const ORG_QUE_SAI = "10191019-0000-4000-8000-000000000002";
const GESTOR = "10191019-1111-4000-8000-000000000001"; // manager
const ATENDENTE = "10191019-1111-4000-8000-000000000002"; // agent, dono do negócio
const PIPELINE = "10191019-5555-4000-8000-000000000001";
const ETAPA = "10191019-5555-4000-8000-000000000002";
const PIPELINE_QUE_SAI = "10191019-5555-4000-8000-000000000003";
const ETAPA_QUE_SAI = "10191019-5555-4000-8000-000000000004";

const C_ABERTO = "10191019-3333-4000-8000-000000000001";
const C_GANHO = "10191019-3333-4000-8000-000000000002";
const C_PERDIDO = "10191019-3333-4000-8000-000000000003";
const C_LIVRE = "10191019-3333-4000-8000-000000000004";
const C_LOTE_ABERTO = "10191019-3333-4000-8000-000000000005";
const C_LOTE_LIVRE = "10191019-3333-4000-8000-000000000006";
const C_DA_ORG_QUE_SAI = "10191019-3333-4000-8000-000000000007";

const L_ABERTO = "10191019-6666-4000-8000-000000000001";
const L_GANHO = "10191019-6666-4000-8000-000000000002";
const L_PERDIDO = "10191019-6666-4000-8000-000000000003";
const L_LOTE_ABERTO = "10191019-6666-4000-8000-000000000004";
const L_DA_ORG_QUE_SAI = "10191019-6666-4000-8000-000000000005";

function lista(ids: string[]): string {
  return ids.map((id) => `'${id}'`).join(", ");
}

/** Roda e devolve o stderr da recusa (vazio se passou). VERBOSITY verbose põe o SQLSTATE na linha. */
function recusa(script: string): string {
  try {
    sql(`\\set VERBOSITY verbose\n${script}`);
    return "";
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? String(err)).replace(/\s+/g, " ");
  }
}

function comoGestor(script: string): string {
  return `
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${GESTOR}","role":"authenticated"}', false);
    ${script}
  `;
}

function existe(contato: string): boolean {
  return (
    lastLine(sql(`select exists(select 1 from public.contacts where id = '${contato}');`)) === "t"
  );
}

function limpar(): void {
  sql(`
    delete from public.crm_leads where organization_id in ('${ORG}', '${ORG_QUE_SAI}');
    delete from public.crm_stages where organization_id in ('${ORG}', '${ORG_QUE_SAI}');
    delete from public.crm_pipelines where organization_id in ('${ORG}', '${ORG_QUE_SAI}');
    delete from public.contacts where organization_id in ('${ORG}', '${ORG_QUE_SAI}');
    delete from public.user_organizations where organization_id in ('${ORG}', '${ORG_QUE_SAI}');
    delete from public.organizations where id in ('${ORG}', '${ORG_QUE_SAI}');
    delete from auth.users where id in ('${GESTOR}', '${ATENDENTE}');
  `);
}

describe("contato com negócio em aberto não sai, em nenhum caminho (migration 1019)", () => {
  beforeAll(() => {
    limpar();
    sql(`
      insert into auth.users (id, email) values
        ('${GESTOR}', 'negocio-aberto-gestor@invariant.test'),
        ('${ATENDENTE}', 'negocio-aberto-atendente@invariant.test')
      on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG}', 'negocio-aberto-inv', 'Negocio Aberto Invariant', 'Negocio Aberto'),
        ('${ORG_QUE_SAI}', 'negocio-aberto-inv-sai', 'Negocio Aberto Org Que Sai', 'Org Que Sai')
      on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${GESTOR}', '${ORG}', 'manager', now()),
        ('${ATENDENTE}', '${ORG}', 'agent', now())
      on conflict (user_id, organization_id) do nothing;
      insert into public.crm_pipelines (id, organization_id, name, slug) values
        ('${PIPELINE}', '${ORG}', 'Negocio Aberto', 'negocio-aberto-inv'),
        ('${PIPELINE_QUE_SAI}', '${ORG_QUE_SAI}', 'Org Que Sai', 'negocio-aberto-inv-sai')
      on conflict (id) do nothing;
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
        ('${ETAPA}', '${ORG}', '${PIPELINE}', 'Proposta', 'proposta', 9100),
        ('${ETAPA_QUE_SAI}', '${ORG_QUE_SAI}', '${PIPELINE_QUE_SAI}', 'Proposta', 'proposta', 9100)
      on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, display_name) values
        ('${C_ABERTO}', '${ORG}', 'Com negocio aberto'),
        ('${C_GANHO}', '${ORG}', 'Com negocio ganho'),
        ('${C_PERDIDO}', '${ORG}', 'Com negocio perdido'),
        ('${C_LIVRE}', '${ORG}', 'Sem negocio'),
        ('${C_LOTE_ABERTO}', '${ORG}', 'Lote com negocio aberto'),
        ('${C_LOTE_LIVRE}', '${ORG}', 'Lote sem negocio'),
        ('${C_DA_ORG_QUE_SAI}', '${ORG_QUE_SAI}', 'Da org que sai')
      on conflict (id) do nothing;
      -- O negócio aberto é do ATENDENTE: a RLS de um agent com visibilidade "own"
      -- o esconderia de outro agent, e o gatilho (definer) tem de enxergá-lo mesmo assim.
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id, status, owner_user_id, owner_kind)
        values ('${L_ABERTO}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'aberto', '${C_ABERTO}', 'open', '${ATENDENTE}', 'user'),
               ('${L_LOTE_ABERTO}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'lote aberto', '${C_LOTE_ABERTO}', 'open', '${ATENDENTE}', 'user'),
               ('${L_DA_ORG_QUE_SAI}', '${ORG_QUE_SAI}', '${PIPELINE_QUE_SAI}', '${ETAPA_QUE_SAI}', 'org sai', '${C_DA_ORG_QUE_SAI}', 'open', null, null);
      -- Mesma forma de ganho e perdido de gov-8-metrics (closed_at; lost_reason só no perdido).
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id, status, closed_at, lost_reason)
        values ('${L_GANHO}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'ganho', '${C_GANHO}', 'won', now(), null),
               ('${L_PERDIDO}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'perdido', '${C_PERDIDO}', 'lost', now(), 'price');
    `);
  });

  afterAll(() => {
    limpar();
  });

  it("o fixture tem o que diz ter: um aberto, um ganho e um perdido", () => {
    const status = sql(
      `select string_agg(status, ',' order by title) from public.crm_leads
        where id in ('${L_ABERTO}', '${L_GANHO}', '${L_PERDIDO}');`,
    );
    expect(lastLine(status)).toBe("open,won,lost");
  });

  it("(a) DELETE direto do contato com negócio aberto é recusado com HB409", () => {
    const erro = recusa(`delete from public.contacts where id = '${C_ABERTO}';`);
    expect(erro).toContain("HB409");
    expect(erro).toContain("contato_com_negocio_aberto");
    expect(existe(C_ABERTO)).toBe(true);
    // O negócio segue apontando para o contato (o SET NULL não rodou).
    expect(lastLine(sql(`select contact_id from public.crm_leads where id = '${L_ABERTO}';`))).toBe(
      C_ABERTO,
    );
  });

  it("(a) a RPC da lixeira, chamada por um membro, também é recusada", () => {
    const erro = recusa(
      comoGestor(`select public.fn_apagar_contato_com_historico('${C_ABERTO}', '${ORG}');`),
    );
    expect(erro).toContain("HB409");
    expect(existe(C_ABERTO)).toBe(true);
  });

  it("(b) negócio ganho ou perdido não barra: o contato sai e o negócio fica sem contato", () => {
    expect(
      recusa(
        comoGestor(`
          select public.fn_apagar_contato_com_historico('${C_GANHO}', '${ORG}');
          select public.fn_apagar_contato_com_historico('${C_PERDIDO}', '${ORG}');
        `),
      ),
    ).toBe("");
    expect(existe(C_GANHO)).toBe(false);
    expect(existe(C_PERDIDO)).toBe(false);
    expect(
      lastLine(
        sql(`select count(*) from public.crm_leads
              where id in ('${L_GANHO}', '${L_PERDIDO}') and contact_id is null;`),
      ),
    ).toBe("2");
  });

  it("(b) contato sem negócio sai pelo DELETE direto", () => {
    expect(recusa(`delete from public.contacts where id = '${C_LIVRE}';`)).toBe("");
    expect(existe(C_LIVRE)).toBe(false);
  });

  it("(d) o lote pula, sem abortar, o contato com negócio aberto", () => {
    const out = sql(
      comoGestor(
        `select array_to_string(public.fn_excluir_contatos_em_lote('${ORG}', array[${lista([C_LOTE_ABERTO, C_LOTE_LIVRE])}]::uuid[]), ',');`,
      ),
    );
    expect(lastLine(out)).toBe(C_LOTE_LIVRE);
    expect(existe(C_LOTE_ABERTO)).toBe(true);
    expect(existe(C_LOTE_LIVRE)).toBe(false);
  });

  it("negócio fechado depois libera o contato", () => {
    sql(`update public.crm_leads set status = 'won', closed_at = now() where id = '${L_ABERTO}';`);
    expect(recusa(`delete from public.contacts where id = '${C_ABERTO}';`)).toBe("");
    expect(existe(C_ABERTO)).toBe(false);
  });

  it("(c) excluir a organização inteira continua funcionando, com negócio aberto e tudo", () => {
    expect(recusa(`delete from public.organizations where id = '${ORG_QUE_SAI}';`)).toBe("");
    expect(
      lastLine(
        sql(`select (select count(*) from public.contacts where organization_id = '${ORG_QUE_SAI}')
                  + (select count(*) from public.crm_leads where organization_id = '${ORG_QUE_SAI}');`),
      ),
    ).toBe("0");
  });

  it("a função do gatilho não é alcançável pela REST e termina o search_path com pg_temp", () => {
    const out = sql(`
      select has_function_privilege('anon', 'public.fn_contato_com_negocio_aberto_nao_sai()', 'execute'),
             has_function_privilege('authenticated', 'public.fn_contato_com_negocio_aberto_nao_sai()', 'execute'),
             p.prosecdef,
             exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%pg_temp%')
        from pg_proc p
       where p.oid = 'public.fn_contato_com_negocio_aberto_nao_sai()'::regprocedure;
    `);
    expect(lastLine(out)).toBe("f|f|t|t");
  });
});
