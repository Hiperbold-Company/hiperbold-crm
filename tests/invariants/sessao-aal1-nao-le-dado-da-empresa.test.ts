/**
 * D-092, 3a parte (migration 1006, fork Hiperbold): a sessão só com senha (aal1) de quem TEM fator TOTP
 * verificado também não LÊ o dado da empresa pelo PostgREST.
 *
 * A 0918, a 0949 e a 0950 fecharam a escrita; a leitura seguia livre, e um token aal1 tirado direto do
 * GoTrue (a chave pública vai para o browser) lia a Inbox inteira. Aqui se prova no Postgres real, como
 * `authenticated`, com o `aal` no JWT:
 *
 *   1. toda tabela tenant-aware de `public` com política permissiva tem `sessao_com_prova_de_mfa`
 *      (RESTRICTIVE, ALL, só authenticated, pela ponte em initplan), menos as duas do login;
 *   2. tabela só do servidor segue sem política nenhuma (ai_mcp_connections nem tem grant);
 *   3. ⭐ admin com fator em aal1 lê ZERO conversas e mensagens; o outro admin com fator em aal2 lê todas;
 *      quem não tem fator lê como antes; service_role não muda;
 *   4. as tabelas do login (user_organizations com o embed de organizations) seguem legíveis no aal1,
 *      senão a pessoa cairia em /get-started em vez de ir ao /login/mfa;
 *   5. o aal1 com fator também não grava numa tabela que as 0949/0950 não cobriam (contacts).
 *
 * Roda via `pnpm test:db tests/invariants/sessao-aal1-nao-le-dado-da-empresa.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "10060001-a5aa-4000-8000-000000000001";
const COM_FATOR_AAL1 = "10060001-b0b0-4000-8000-000000000001";
const COM_FATOR_AAL2 = "10060001-b0b0-4000-8000-000000000002";
const SEM_FATOR = "10060001-b0b0-4000-8000-000000000003";
const FATOR_1 = "10060001-f0f0-4000-8000-000000000001";
const FATOR_2 = "10060001-f0f0-4000-8000-000000000002";
const SESSAO = "10060001-5e55-4000-8000-000000000001";
const CONTATO = "10060001-c0c0-4000-8000-000000000001";
const CONVERSA = "10060001-c0c0-4000-8000-000000000002";
const MENSAGEM = "10060001-c0c0-4000-8000-000000000003";

/** Roda `corpo` como `authenticated`, com o JWT do usuário no nível `aal` dado; devolve a última linha. */
function como(usuario: string, aal: "aal1" | "aal2", corpo: string): string {
  const saida = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"${aal}"}', false);
    ${corpo}
  `);
  return saida.split("\n").pop() ?? "";
}

const contarConversas = `select count(*) from public.conversations where organization_id = '${ORG}'::uuid;`;
const contarMensagens = `select count(*) from public.messages where organization_id = '${ORG}'::uuid;`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${COM_FATOR_AAL1}', 'fator-aal1-1006@invariant.test'),
      ('${COM_FATOR_AAL2}', 'fator-aal2-1006@invariant.test'),
      ('${SEM_FATOR}', 'sem-fator-1006@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'mfa-1006', 'MFA 1006', 'MFA 1006')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${COM_FATOR_AAL1}', '${ORG}', 'admin', now()),
      ('${COM_FATOR_AAL2}', '${ORG}', 'admin', now()),
      ('${SEM_FATOR}', '${ORG}', 'admin', now())
      on conflict do nothing;

    insert into auth.mfa_factors (id, user_id, status, factor_type) values
      ('${FATOR_1}', '${COM_FATOR_AAL1}', 'verified', 'totp'),
      ('${FATOR_2}', '${COM_FATOR_AAL2}', 'verified', 'totp')
      on conflict (id) do nothing;

    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'mfa-1006', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${ORG}', 'Contato 1006') on conflict do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${SESSAO}', 'open') on conflict (id) do nothing;

    insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${MENSAGEM}', '${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'text', 'inbound', 'mensagem 1006')
      on conflict (id) do nothing;
  `);
});

describe("cobertura: toda tabela tenant-aware com porta tem a trava, menos as do login", () => {
  it("nenhuma tabela tenant-aware com política permissiva ficou sem `sessao_com_prova_de_mfa`", () => {
    const faltando = sql(`
      select coalesce(string_agg(c.relname, ',' order by c.relname), '')
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition and c.relrowsecurity
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
         and c.relname not in ('organizations', 'user_organizations')
         and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polpermissive)
         and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'sessao_com_prova_de_mfa');
    `);
    expect(faltando).toBe("");
  });

  it("o instrumento mede algo: dezenas de tabelas cobertas, conversations e messages entre elas", () => {
    const n = Number(sql(`select count(*) from pg_policies where schemaname='public' and policyname='sessao_com_prova_de_mfa';`));
    expect(n).toBeGreaterThan(50);
    for (const t of ["conversations", "messages", "contacts", "crm_leads", "crm_lead_activities", "api_tokens"]) {
      expect(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${t}' and policyname='sessao_com_prova_de_mfa';`), t).toBe("1");
    }
  });

  it("a forma da política: RESTRICTIVE, ALL, só authenticated, pela ponte em initplan nos dois lados", () => {
    const formas = sql(`
      select distinct permissive || '|' || cmd || '|' || roles::text || '|' ||
             (qual ilike '%select%fn_session_mfa_proven_rls()%')::text || '|' ||
             (with_check ilike '%select%fn_session_mfa_proven_rls()%')::text
        from pg_policies where schemaname='public' and policyname='sessao_com_prova_de_mfa';
    `);
    expect(formas).toBe("RESTRICTIVE|ALL|{authenticated}|true|true");
  });

  it("organizations e user_organizations ficam de fora, de propósito (o login monta a sessão com elas)", () => {
    expect(
      sql(`select count(*) from pg_policies where schemaname='public' and policyname='sessao_com_prova_de_mfa'
            and tablename in ('organizations','user_organizations');`),
    ).toBe("0");
  });

  it("tabela só do servidor segue com zero políticas; ai_mcp_connections nem tem grant para authenticated", () => {
    expect(sql(`select count(*) from pg_policy where polrelid = 'public.ai_mcp_connections'::regclass;`)).toBe("0");
    expect(
      sql(`select has_table_privilege('authenticated','public.ai_mcp_connections','select')
              or has_table_privilege('authenticated','public.ai_mcp_connections','insert')
              or has_table_privilege('authenticated','public.ai_mcp_connections','update');`),
    ).toBe("f");
  });
});

describe("⭐ leitura: aal1 de quem tem fator vê vazio; aal2 vê tudo", () => {
  it("admin com fator em aal1: zero conversas e zero mensagens", () => {
    expect(como(COM_FATOR_AAL1, "aal1", contarConversas)).toBe("0");
    expect(como(COM_FATOR_AAL1, "aal1", contarMensagens)).toBe("0");
    expect(como(COM_FATOR_AAL1, "aal1", `select count(*) from public.contacts where organization_id='${ORG}'::uuid;`)).toBe("0");
  });

  it("CONTROLE POSITIVO: o outro admin com fator, em aal2, lê a conversa e a mensagem", () => {
    expect(como(COM_FATOR_AAL2, "aal2", contarConversas)).toBe("1");
    expect(como(COM_FATOR_AAL2, "aal2", contarMensagens)).toBe("1");
  });

  it("o mesmo admin do aal1, depois de provar o fator (aal2), volta a ler", () => {
    expect(como(COM_FATOR_AAL1, "aal2", contarConversas)).toBe("1");
  });

  it("quem não tem fator, em aal1, lê como antes (a verificação é opcional)", () => {
    expect(como(SEM_FATOR, "aal1", contarConversas)).toBe("1");
    expect(como(SEM_FATOR, "aal1", contarMensagens)).toBe("1");
  });

  it("service_role não muda", () => {
    const n = sql(`set role service_role; ${contarMensagens}`).split("\n").pop();
    expect(n).toBe("1");
  });
});

describe("o fluxo de login segue funcionando no aal1", () => {
  it("user_organizations com o embed de organizations (o que loadAuthUser lê) segue legível", () => {
    const linha = como(
      COM_FATOR_AAL1,
      "aal1",
      `select uo.role || '|' || o.display_name from public.user_organizations uo
         join public.organizations o on o.id = uo.organization_id
        where uo.user_id = '${COM_FATOR_AAL1}'::uuid and uo.revoked_at is null;`,
    );
    expect(linha).toBe("admin|MFA 1006");
  });

  it("fn_session_mfa_proven responde false no aal1 com fator e true no aal2 (o app pergunta isto)", () => {
    expect(como(COM_FATOR_AAL1, "aal1", "select public.fn_session_mfa_proven();")).toBe("f");
    expect(como(COM_FATOR_AAL1, "aal2", "select public.fn_session_mfa_proven();")).toBe("t");
  });
});

describe("escrita: a trava vale também onde a 0949/0950 não chegavam", () => {
  it("o aal1 de quem tem fator não insere contato; o aal2 insere", () => {
    let motivo = "";
    try {
      como(COM_FATOR_AAL1, "aal1", `insert into public.contacts (organization_id, display_name) values ('${ORG}', 'do aal1');`);
    } catch (err) {
      motivo = motivoDoErro(err);
    }
    expect(motivo, "a sessão aal1 criou um contato").toContain("row-level security");
    como(COM_FATOR_AAL2, "aal2", `insert into public.contacts (organization_id, display_name) values ('${ORG}', 'do aal2');`);
    expect(sql(`select count(*) from public.contacts where organization_id='${ORG}' and display_name in ('do aal1','do aal2');`)).toBe("1");
  });
});
