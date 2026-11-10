import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * O COFRE DE CHAVES DAS AUTOMAÇÕES (migration 1004, `automacao_segredos`).
 *
 * Duas garantias, medidas no banco aplicado do baseline:
 *  1. o valor cifrado NUNCA é legível por `anon` nem por `authenticated` —
 *     nem pela organização dona: só a service role lê `valor_cifrado`;
 *  2. isolamento entre organizações: o gerente de uma não vê a chave da outra,
 *     o atendente (abaixo de gerente) não vê nem as da própria, e ninguém grava
 *     pelo PostgREST (escrita só pelas rotas, com a service role).
 *
 * `set role authenticated` + `request.jwt.claims`: o caminho da produção
 * (conectar como `postgres` ignoraria a RLS e não mediria nada).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

function como(papel: "authenticated" | "anon", userId: string | null, comando: string): string {
  try {
    const out = sql(`
      set role ${papel};
      ${userId ? `select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);` : ""}
      ${comando}
    `);
    const linhas = out.split("\n");
    return linhas[linhas.length - 1] ?? "";
  } catch (err) {
    return `ERRO: ${String((err as { stderr?: string }).stderr ?? err)}`;
  }
}

const ORG_A = "dddddddd-1004-4000-8000-00000000000a";
const ORG_B = "dddddddd-1004-4000-8000-00000000000b";
const GERENTE_A = "dddddddd-1004-4000-8000-0000000000a1";
const ATENDENTE_A = "dddddddd-1004-4000-8000-0000000000a2";
const GERENTE_B = "dddddddd-1004-4000-8000-0000000000b1";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${GERENTE_A}', 'cofre-ga@invariant.test'), ('${ATENDENTE_A}', 'cofre-aa@invariant.test'),
      ('${GERENTE_B}', 'cofre-gb@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'cofre-inv-a', 'Cofre A', 'Cofre A'), ('${ORG_B}', 'cofre-inv-b', 'Cofre B', 'Cofre B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GERENTE_A}', '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_A}', '${ORG_A}', 'agent', now()),
      ('${GERENTE_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.automacao_segredos (organization_id, nome, valor_cifrado, ultimos4) values
      ('${ORG_A}', 'token_a', '\\x01020304'::bytea, '1234'),
      ('${ORG_B}', 'token_b', '\\x05060708'::bytea, '5678')
      on conflict do nothing;
  `);
});

describe("automacao_segredos: o valor cifrado é só do servidor", () => {
  it("nenhum privilégio de SELECT em valor_cifrado para anon ou authenticated (nem de tabela, nem de coluna)", () => {
    expect(
      sql(`select count(*) from information_schema.column_privileges
            where table_schema='public' and table_name='automacao_segredos' and column_name='valor_cifrado'
              and grantee in ('anon','authenticated','PUBLIC');`),
    ).toBe("0");
    expect(
      sql(`select count(*) from information_schema.role_table_grants
            where table_schema='public' and table_name='automacao_segredos'
              and grantee in ('anon','authenticated','PUBLIC') and privilege_type <> 'SELECT';`),
    ).toBe("0");
    expect(
      sql(
        "select has_column_privilege('authenticated', 'public.automacao_segredos', 'valor_cifrado', 'select');",
      ),
    ).toBe("f");
    expect(sql("select has_table_privilege('anon', 'public.automacao_segredos', 'select');")).toBe(
      "f",
    );
  });

  it("o gerente dono lê nome e final (controle positivo), mas pedir valor_cifrado é negado", () => {
    expect(
      como(
        "authenticated",
        GERENTE_A,
        "select string_agg(nome || ':' || ultimos4, ',') from public.automacao_segredos;",
      ),
    ).toBe("token_a:1234");
    expect(
      como("authenticated", GERENTE_A, "select valor_cifrado from public.automacao_segredos;"),
    ).toMatch(/permission denied/);
    expect(como("authenticated", GERENTE_A, "select * from public.automacao_segredos;")).toMatch(
      /permission denied/,
    );
  });

  it("anon não lê nada", () => {
    expect(como("anon", null, "select count(*) from public.automacao_segredos;")).toMatch(
      /permission denied/,
    );
  });

  it("a service role lê o valor cifrado (é ela que decifra no envio)", () => {
    expect(
      sql(
        "set role service_role; select count(*) from public.automacao_segredos where valor_cifrado is not null;",
      ),
    ).not.toBe("0");
  });
});

describe("automacao_segredos: isolamento entre organizações", () => {
  it("o gerente de B não vê a chave de A (e vice-versa)", () => {
    expect(
      como(
        "authenticated",
        GERENTE_B,
        "select string_agg(nome, ',') from public.automacao_segredos;",
      ),
    ).toBe("token_b");
    expect(
      como(
        "authenticated",
        GERENTE_B,
        `select count(*) from public.automacao_segredos where organization_id = '${ORG_A}';`,
      ),
    ).toBe("0");
  });

  it("atendente (abaixo de gerente) não vê nem as da própria organização", () => {
    expect(
      como("authenticated", ATENDENTE_A, "select count(id) from public.automacao_segredos;"),
    ).toBe("0");
  });

  it("ninguém grava pelo PostgREST: insert, update e delete de authenticated são negados", () => {
    expect(
      como(
        "authenticated",
        GERENTE_A,
        `insert into public.automacao_segredos (organization_id, nome, valor_cifrado, ultimos4) values ('${ORG_A}', 'nova', '\\x00', '0000');`,
      ),
    ).toMatch(/permission denied/);
    expect(
      como("authenticated", GERENTE_A, "update public.automacao_segredos set ultimos4 = '9999';"),
    ).toMatch(/permission denied/);
    expect(como("authenticated", GERENTE_A, "delete from public.automacao_segredos;")).toMatch(
      /permission denied/,
    );
  });

  it("o nome é único por organização e segue o formato", () => {
    expect(() =>
      sql(
        `insert into public.automacao_segredos (organization_id, nome, valor_cifrado, ultimos4) values ('${ORG_A}', 'token_a', '\\x00', '0000');`,
      ),
    ).toThrow(/uniq_automacao_segredos_org_nome/);
    expect(() =>
      sql(
        `insert into public.automacao_segredos (organization_id, nome, valor_cifrado, ultimos4) values ('${ORG_A}', 'Nome Ruim', '\\x00', '0000');`,
      ),
    ).toThrow(/automacao_segredos_nome_valido/);
  });
});
