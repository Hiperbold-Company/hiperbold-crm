/**
 * RELATOS DE PROBLEMA (migration 1018): nenhum papel do PostgREST além do service_role toca a
 * tabela. Quem grava é a rota, pelo admin client, com organização e usuário da sessão.
 *
 * Medido em Postgres real, com JWT simulado (`set role authenticated` + `request.jwt.claims`):
 *   · membro (viewer) da A NÃO insere nem na A (a REST furaria o limite por hora e a poda);
 *   · `authenticated` não lê (nem o próprio relato), não altera, não apaga;
 *   · `anon` não tem privilégio nenhum;
 *   · o `service_role` grava, lê e altera (o caminho da rota);
 *   · `page_url` só aceita caminho relativo (CHECK); o caminho do print só `<org>/<id>.webp|png`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG_A = "dddddddd-1018-4000-8000-00000000000a";
const ORG_B = "dddddddd-1018-4000-8000-00000000000b";
const ANA = "dddddddd-1018-4000-8000-000000000001";
const BETO_B = "dddddddd-1018-4000-8000-000000000002";
const RELATO_DO_SERVIDOR = "dddddddd-1018-4000-8000-0000000000f1";

const DESCRICAO = "A tela de contatos não carrega.";

/** Roda como `authenticated` com o JWT do usuário; devolve "ok" ou o SQLSTATE/mensagem do erro. */
function comoUsuario(userId: string, comando: string): string {
  try {
    return lastLine(
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false);
        ${comando};
        select 'ok';
      `),
    );
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

function comoAnon(comando: string): string {
  try {
    return lastLine(sql(`set role anon; ${comando}; select 'ok';`));
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

const contar = (onde: string) =>
  Number(sql(`select count(*) from public.bug_reports where ${onde};`));

beforeAll(() => {
  sql(`
    delete from public.bug_reports where organization_id in ('${ORG_A}', '${ORG_B}');
    insert into auth.users (id, email) values
      ('${ANA}', 'relato-ana@invariant.test'), ('${BETO_B}', 'relato-beto@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'relato-inv-a', 'Relato A', 'Relato A'), ('${ORG_B}', 'relato-inv-b', 'Relato B', 'Relato B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ANA}', '${ORG_A}', 'viewer', now()), ('${BETO_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
    insert into public.bug_reports (id, organization_id, user_id, description)
      values ('${RELATO_DO_SERVIDOR}', '${ORG_A}', '${ANA}', '${DESCRICAO}');
  `);
});

describe("bug_reports: RLS e privilégios", () => {
  it("authenticated NÃO insere, nem na própria organização, nem com created_at no futuro", () => {
    expect(
      comoUsuario(
        ANA,
        `insert into public.bug_reports (organization_id, user_id, description) values ('${ORG_A}', '${ANA}', '${DESCRICAO} [ana]')`,
      ),
    ).toMatch(/permission denied/);
    expect(
      comoUsuario(
        ANA,
        `insert into public.bug_reports (organization_id, user_id, description, created_at) values ('${ORG_A}', '${ANA}', '${DESCRICAO} [futuro]', '2999-01-01')`,
      ),
    ).toMatch(/permission denied/);
    expect(
      comoUsuario(
        BETO_B,
        `insert into public.bug_reports (organization_id, user_id, description) values ('${ORG_B}', '${BETO_B}', '${DESCRICAO} [admin-b]')`,
      ),
    ).toMatch(/permission denied/);
    expect(contar(`description ~ '\\[(ana|futuro|admin-b)\\]$'`)).toBe(0);
  });

  it("nenhuma policy de authenticated sobra na tabela (o drop desfaz a versão anterior)", () => {
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = 'bug_reports' and 'authenticated' = any(roles);`)).toBe("0");
    expect(
      sql(`select count(*) from information_schema.role_table_grants
            where table_schema = 'public' and table_name = 'bug_reports'
              and grantee in ('anon', 'authenticated', 'PUBLIC');`),
    ).toBe("0");
  });

  it("o service_role grava, lê e altera (o caminho da rota)", () => {
    const id = "dddddddd-1018-4000-8000-0000000000f3";
    expect(
      lastLine(
        sql(`
          set role service_role;
          insert into public.bug_reports (id, organization_id, user_id, description) values ('${id}', '${ORG_A}', '${ANA}', '${DESCRICAO}');
          update public.bug_reports set status = 'em_andamento' where id = '${id}';
          select status from public.bug_reports where id = '${id}';
        `),
      ),
    ).toBe("em_andamento");
  });

  it("page_url só aceita caminho relativo da instalação", () => {
    for (const url of ["https://golpe.test", "//golpe.test", "/\\golpe.test", "javascript:alert(1)", "app/x"]) {
      expect(
        () => sql(`insert into public.bug_reports (organization_id, description, page_url) values ('${ORG_A}', '${DESCRICAO}', '${url}');`),
        url,
      ).toThrow(/bug_reports_page_url_check/);
    }
    sql(`insert into public.bug_reports (organization_id, description, page_url) values ('${ORG_A}', '${DESCRICAO} [rel]', '/app/inbox?aba=1');`);
    expect(contar(`description like '%[rel]'`)).toBe(1);
  });

  it("authenticated não lê bug_reports, nem o próprio relato", () => {
    expect(comoUsuario(ANA, `select count(*) from public.bug_reports`)).toMatch(/permission denied/);
    expect(comoUsuario(BETO_B, `select count(*) from public.bug_reports`)).toMatch(/permission denied/);
  });

  it("authenticated não altera nem apaga", () => {
    expect(comoUsuario(ANA, `update public.bug_reports set status = 'resolvido' where id = '${RELATO_DO_SERVIDOR}'`)).toMatch(
      /permission denied/,
    );
    expect(comoUsuario(ANA, `delete from public.bug_reports where id = '${RELATO_DO_SERVIDOR}'`)).toMatch(/permission denied/);
    expect(contar(`id = '${RELATO_DO_SERVIDOR}' and status = 'novo'`)).toBe(1);
  });

  it("anon não lê, não insere, não altera, não apaga", () => {
    expect(comoAnon(`select count(*) from public.bug_reports`)).toMatch(/permission denied/);
    expect(
      comoAnon(`insert into public.bug_reports (organization_id, description) values ('${ORG_A}', '${DESCRICAO} [anon]')`),
    ).toMatch(/permission denied/);
    expect(comoAnon(`update public.bug_reports set status = 'novo'`)).toMatch(/permission denied/);
    expect(comoAnon(`delete from public.bug_reports`)).toMatch(/permission denied/);
    expect(contar(`description like '%[anon]'`)).toBe(0);
  });

  it("o caminho do print só pode ser <org>/<id>.webp ou .png, até para o service role", () => {
    const id = "dddddddd-1018-4000-8000-0000000000f2";
    expect(() =>
      sql(`insert into public.bug_reports (id, organization_id, description, screenshot_path)
           values ('${id}', '${ORG_A}', '${DESCRICAO}', '${ORG_B}/qualquer.webp');`),
    ).toThrow(/bug_reports_screenshot_path_check/);
    sql(`insert into public.bug_reports (id, organization_id, description, screenshot_path)
         values ('${id}', '${ORG_A}', '${DESCRICAO}', '${ORG_A}/${id}.webp');`);
    expect(contar(`id = '${id}'`)).toBe(1);
  });

  it("a descrição respeita 10 a 2000 caracteres no banco", () => {
    expect(() =>
      sql(`insert into public.bug_reports (organization_id, description) values ('${ORG_A}', 'curta');`),
    ).toThrow(/bug_reports_description_check/);
  });

  it("o bucket bug-reports existe e é privado", () => {
    expect(sql(`select public::text || '|' || file_size_limit from storage.buckets where id = 'bug-reports';`)).toBe(
      "false|3145728",
    );
  });
});
