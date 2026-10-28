import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * PREFERÊNCIA DE USUÁRIO É DE UM USUÁRIO SÓ (migration 0978).
 *
 * `user_preferences` guarda apresentação (as colunas da tela de Contatos). O isolamento
 * aqui é mais estreito que o de tenant: na MESMA organização, um colega não lê nem
 * reescreve a escolha do outro. E o vínculo revogado perde o acesso às próprias linhas.
 *
 * Conectar como `postgres` mediria nada (bypassa RLS): `set role authenticated` +
 * `request.jwt.claims`, o caminho da produção.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Roda como o usuário e devolve a última linha da saída (ou o erro do psql). */
function como(userId: string, comando: string): string {
  try {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${comando}
    `);
    const linhas = out.split("\n");
    return linhas[linhas.length - 1] ?? "";
  } catch (err) {
    return `ERRO: ${String((err as { stderr?: string }).stderr ?? err)}`;
  }
}

const ORG_A = "dddddddd-0978-4000-8000-00000000000a";
const ORG_B = "dddddddd-0978-4000-8000-00000000000b";
const ANA = "dddddddd-0978-4000-8000-0000000000a1";
const BETO = "dddddddd-0978-4000-8000-0000000000a2";
const CAIO_B = "dddddddd-0978-4000-8000-0000000000b1";
const EX = "dddddddd-0978-4000-8000-0000000000a3";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ANA}', 'pref-ana@invariant.test'), ('${BETO}', 'pref-beto@invariant.test'),
      ('${CAIO_B}', 'pref-caio@invariant.test'), ('${EX}', 'pref-ex@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'pref-inv-a', 'Pref A', 'Pref A'), ('${ORG_B}', 'pref-inv-b', 'Pref B', 'Pref B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at) values
      ('${ANA}', '${ORG_A}', 'viewer', now(), null),
      ('${BETO}', '${ORG_A}', 'admin', now(), null),
      ('${CAIO_B}', '${ORG_B}', 'admin', now(), null),
      ('${EX}', '${ORG_A}', 'agent', now() - interval '2 days', now() - interval '1 day')
      on conflict do nothing;
    insert into public.user_preferences (organization_id, user_id, chave, valor) values
      ('${ORG_A}', '${ANA}', 'contatos.colunas', '{"colunas":["nome","email","acoes"]}'),
      ('${ORG_A}', '${EX}', 'contatos.colunas', '{"colunas":["nome","acoes"]}');
  `);
});

describe("user_preferences: cada um só o seu", () => {
  it("o dono lê a própria linha (controle positivo)", () => {
    expect(como(ANA, "select count(*) from public.user_preferences;")).toBe("1");
  });

  it("colega da MESMA organização (admin inclusive) não lê nem altera", () => {
    expect(como(BETO, "select count(*) from public.user_preferences;")).toBe("0");
    expect(
      como(BETO, `with u as (update public.user_preferences set valor = '{}' where user_id = '${ANA}' returning 1) select count(*) from u;`),
    ).toBe("0");
  });

  it("ninguém grava linha em nome de outro usuário nem em organização de que não é membro", () => {
    expect(
      como(BETO, `insert into public.user_preferences (organization_id, user_id, chave) values ('${ORG_A}', '${ANA}', 'x.y');`),
    ).toMatch(/row-level security/);
    expect(
      como(CAIO_B, `insert into public.user_preferences (organization_id, user_id, chave) values ('${ORG_A}', '${CAIO_B}', 'x.y');`),
    ).toMatch(/row-level security/);
    expect(como(CAIO_B, "select count(*) from public.user_preferences;")).toBe("0");
  });

  it("vínculo revogado perde as próprias linhas", () => {
    expect(como(EX, "select count(*) from public.user_preferences;")).toBe("0");
  });

  it("o dono grava (upsert) e a forma do valor é cobrada pelo banco", () => {
    expect(
      como(
        ANA,
        `with u as (insert into public.user_preferences (organization_id, user_id, chave, valor)
           values ('${ORG_A}', '${ANA}', 'contatos.colunas', '{"colunas":["nome","tags","acoes"]}')
           on conflict (organization_id, user_id, chave) do update set valor = excluded.valor
           returning valor->'colunas'->>1 as segunda) select segunda from u;`,
      ),
    ).toBe("tags");
    expect(
      como(ANA, `insert into public.user_preferences (organization_id, user_id, chave, valor) values ('${ORG_A}', '${ANA}', 'outra', '[1]');`),
    ).toMatch(/user_preferences_valor_objeto/);
  });

  it("anon não tem privilégio nenhum na tabela", () => {
    expect(sql("select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='user_preferences' and grantee='anon';")).toBe("0");
  });
});
