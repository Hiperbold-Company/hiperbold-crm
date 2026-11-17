import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * CAMPOS PERSONALIZADOS DA ORGANIZAÇÃO (migration 1015, `custom_field_definitions`).
 *
 * Medido no banco aplicado do baseline:
 *  1. isolamento: o membro de uma organização não lê a definição da outra; abaixo de gerente lê a
 *     da própria mas não grava; anon não alcança nada;
 *  2. a projeção: `crm_pipelines.settings.fields` vira as definições da organização com a
 *     obrigatoriedade de cada funil, e apagar a última definição deixa `fields = []`;
 *  3. key/type imutáveis no banco;
 *  4. a migração de dados (reaplicada sobre uma organização só com o legado) deduplica a chave
 *     entre funis, guarda `campos_legados` e monta `campos_obrigatorios`.
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

const ORG_A = "eeeeeeee-1015-4000-8000-00000000000a";
const ORG_B = "eeeeeeee-1015-4000-8000-00000000000b";
const ORG_LEGADO = "eeeeeeee-1015-4000-8000-00000000000c";
const GERENTE_A = "eeeeeeee-1015-4000-8000-0000000000a1";
const ATENDENTE_A = "eeeeeeee-1015-4000-8000-0000000000a2";
const GERENTE_B = "eeeeeeee-1015-4000-8000-0000000000b1";
const FUNIL_A = "eeeeeeee-1015-4000-8000-0000000000f1";
const FUNIL_L1 = "eeeeeeee-1015-4000-8000-0000000000c1";
const FUNIL_L2 = "eeeeeeee-1015-4000-8000-0000000000c2";

const MIGRATION = "supabase/migrations/20261117100000_1015_campos_personalizados_da_organizacao.sql";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${GERENTE_A}', 'cp-ga@invariant.test'), ('${ATENDENTE_A}', 'cp-aa@invariant.test'),
      ('${GERENTE_B}', 'cp-gb@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'cp-inv-a', 'CP A', 'CP A'), ('${ORG_B}', 'cp-inv-b', 'CP B', 'CP B'),
      ('${ORG_LEGADO}', 'cp-inv-c', 'CP C', 'CP C')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GERENTE_A}', '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_A}', '${ORG_A}', 'agent', now()),
      ('${GERENTE_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug, settings) values
      ('${FUNIL_A}', '${ORG_A}', 'Vendas', 'cp-vendas-a',
       '{"fields": [], "campos_obrigatorios": {"origem": {"ao_ganhar": true}}}')
      on conflict (id) do nothing;
    insert into public.custom_field_definitions (organization_id, entidade, key, label, type) values
      ('${ORG_A}', 'negocio', 'origem', 'Origem', 'text'),
      ('${ORG_A}', 'contato', 'cpf', 'CPF', 'text'),
      ('${ORG_B}', 'negocio', 'segredo_b', 'Segredo B', 'text')
      on conflict do nothing;
  `);
});

describe("custom_field_definitions: isolamento entre organizações", () => {
  it("o gerente de B não vê as definições de A", () => {
    expect(como("authenticated", GERENTE_B, "select string_agg(key, ',' order by key) from public.custom_field_definitions;")).toBe(
      "segredo_b",
    );
  });

  it("o atendente de A LÊ as da própria organização, mas não grava", () => {
    expect(como("authenticated", ATENDENTE_A, "select count(*) from public.custom_field_definitions;")).toBe("2");
    expect(
      como(
        "authenticated",
        ATENDENTE_A,
        `insert into public.custom_field_definitions (organization_id, entidade, key, label, type) values ('${ORG_A}', 'negocio', 'x', 'X', 'text');`,
      ),
    ).toMatch(/row-level security|permission denied/);
    expect(como("authenticated", ATENDENTE_A, "update public.custom_field_definitions set label = 'H' returning id;")).toBe("");
  });

  it("o gerente de A não grava na organização B (with check)", () => {
    expect(
      como(
        "authenticated",
        GERENTE_A,
        `insert into public.custom_field_definitions (organization_id, entidade, key, label, type) values ('${ORG_B}', 'negocio', 'invasor', 'X', 'text');`,
      ),
    ).toMatch(/row-level security/);
  });

  it("anon não alcança a tabela nem as funções", () => {
    expect(como("anon", null, "select count(*) from public.custom_field_definitions;")).toMatch(/permission denied/);
    expect(
      sql("select has_function_privilege('anon', 'public.fn_estatisticas_do_campo_personalizado(uuid, text, text)', 'execute');"),
    ).toBe("f");
    expect(
      sql("select has_function_privilege('authenticated', 'public.fn_campos_personalizados_projetados(uuid, jsonb)', 'execute');"),
    ).toBe("f");
  });
});

describe("a projeção em crm_pipelines.settings.fields", () => {
  it("o funil recebe contato + negócio da organização, com a obrigatoriedade DELE", () => {
    const fields = JSON.parse(sql(`select settings->'fields' from public.crm_pipelines where id = '${FUNIL_A}';`)) as Array<
      Record<string, unknown>
    >;
    expect(fields.map((f) => f.key).sort()).toEqual(["cpf", "origem"]);
    expect(fields.find((f) => f.key === "cpf")?.escopo).toBe("contato");
    expect(fields.find((f) => f.key === "origem")?.obrigatorio_em).toEqual({ ao_ganhar: true });
  });

  it("escrever fields à mão numa organização com definições não pega (o banco reprojeta)", () => {
    sql(`update public.crm_pipelines set settings = settings || '{"fields": [{"key":"fantasma","label":"F","type":"text"}]}' where id = '${FUNIL_A}';`);
    expect(sql(`select settings->'fields' @> '[{"key":"fantasma"}]' from public.crm_pipelines where id = '${FUNIL_A}';`)).toBe("f");
  });

  it("key e type não mudam depois de criados", () => {
    expect(() => sql(`update public.custom_field_definitions set type = 'number' where organization_id = '${ORG_A}' and key = 'origem';`)).toThrow(
      /não mudam/,
    );
  });

  it("a chave é única na organização sem diferenciar maiúsculas", () => {
    expect(() =>
      sql(`insert into public.custom_field_definitions (organization_id, entidade, key, label, type) values ('${ORG_A}', 'contato', 'ORIGEM', 'O', 'text');`),
    ).toThrow(/uniq_custom_field_definitions_org_key/);
  });
});

describe("a migração de dados da 1015 (reaplicada)", () => {
  beforeAll(() => {
    sql(`
      insert into public.crm_pipelines (id, organization_id, name, slug, settings, created_at) values
        ('${FUNIL_L1}', '${ORG_LEGADO}', 'Antigo', 'cp-legado-1',
         '{"fields": [{"key":"cidade","label":"Cidade","type":"text","obrigatorio_em":{"ao_perder":true}},
                      {"key":"cpf","label":"CPF","type":"text","escopo":"contato"}]}', now() - interval '2 days'),
        ('${FUNIL_L2}', '${ORG_LEGADO}', 'Novo', 'cp-legado-2',
         '{"fields": [{"key":"Cidade","label":"Cidade 2","type":"number"},
                      {"key":"valor","label":"Valor","type":"currency","required":true}]}', now() - interval '1 day')
        on conflict (id) do nothing;
    `);
    sql(readFileSync(MIGRATION, "utf8"));
  });

  it("uma definição por chave; vence o funil mais antigo", () => {
    expect(
      sql(`select string_agg(entidade || ':' || key || ':' || type, ',' order by position) from public.custom_field_definitions where organization_id = '${ORG_LEGADO}';`),
    ).toBe("negocio:cidade:text,contato:cpf:text,negocio:valor:currency");
  });

  it("guarda a lista original em campos_legados e monta campos_obrigatorios pela chave canônica", () => {
    expect(sql(`select settings ? 'campos_legados' from public.crm_pipelines where id = '${FUNIL_L2}';`)).toBe("t");
    expect(sql(`select settings->'campos_obrigatorios' from public.crm_pipelines where id = '${FUNIL_L1}';`)).toBe(
      '{"cidade": {"ao_perder": true}}',
    );
  });

  it("os dois funis passam a projetar os três campos da organização", () => {
    expect(sql(`select jsonb_array_length(settings->'fields') from public.crm_pipelines where id = '${FUNIL_L2}';`)).toBe("3");
  });

  it("reaplicar de novo não duplica nada", () => {
    sql(readFileSync(MIGRATION, "utf8"));
    expect(sql(`select count(*) from public.custom_field_definitions where organization_id = '${ORG_LEGADO}';`)).toBe("3");
  });

  it("apagar a última definição deixa fields vazio (a organização volta a não ter campos)", () => {
    sql(`delete from public.custom_field_definitions where organization_id = '${ORG_LEGADO}';`);
    expect(sql(`select settings->'fields' from public.crm_pipelines where id = '${FUNIL_L1}';`)).toBe("[]");
  });
});
