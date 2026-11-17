/**
 * RELATOS DE PROBLEMA (migration 1018): o membro só INSERE, e só na própria organização.
 *
 * Medido em Postgres real, com JWT simulado (`set role authenticated` + `request.jwt.claims`):
 *   · membro (viewer) da A insere na A, como ele mesmo;
 *   · o mesmo membro NÃO insere na B, nem em nome de outro usuário, nem já com status/nota;
 *   · `authenticated` não lê (nem o próprio relato), não altera, não apaga;
 *   · `anon` não tem privilégio nenhum;
 *   · o caminho do print só pode ser `<org>/<id>.webp|png` (CHECK, vale até para o service role).
 *
 * Sabotagem prevista: trocar o `with check` por `true` faz o caso "não insere na B" inserir 1;
 * acrescentar `grant select ... to authenticated` com policy de leitura faz o caso de leitura
 * contar linhas.
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
  it("o membro da A insere na A, como ele mesmo", () => {
    const r = comoUsuario(
      ANA,
      `insert into public.bug_reports (organization_id, user_id, description) values ('${ORG_A}', '${ANA}', '${DESCRICAO} [ana]')`,
    );
    expect(r).toBe("ok");
    expect(contar(`organization_id = '${ORG_A}' and description like '%[ana]'`)).toBe(1);
  });

  it("o membro da A NÃO insere na B", () => {
    const r = comoUsuario(
      ANA,
      `insert into public.bug_reports (organization_id, user_id, description) values ('${ORG_B}', '${ANA}', '${DESCRICAO} [cruzado]')`,
    );
    expect(r).toMatch(/row-level security/);
    expect(contar(`description like '%[cruzado]'`)).toBe(0);
  });

  it("nem em nome de outro usuário, nem já com status ou nota do administrador", () => {
    expect(
      comoUsuario(ANA, `insert into public.bug_reports (organization_id, user_id, description) values ('${ORG_A}', '${BETO_B}', '${DESCRICAO} [forjado]')`),
    ).toMatch(/row-level security/);
    expect(
      comoUsuario(ANA, `insert into public.bug_reports (organization_id, user_id, description, status) values ('${ORG_A}', '${ANA}', '${DESCRICAO} [status]', 'resolvido')`),
    ).toMatch(/row-level security/);
    expect(
      comoUsuario(ANA, `insert into public.bug_reports (organization_id, user_id, description, admin_note) values ('${ORG_A}', '${ANA}', '${DESCRICAO} [nota]', 'x')`),
    ).toMatch(/row-level security/);
    expect(contar(`description ~ '\\[(forjado|status|nota)\\]$'`)).toBe(0);
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
