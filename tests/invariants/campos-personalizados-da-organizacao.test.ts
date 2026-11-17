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
 *     entre funis, guarda `campos_legados`, monta `campos_obrigatorios` e GRAVA o conflito em
 *     `organizations.settings.campos_conflitos`;
 *  5. a primeira definição de uma organização ainda no legado ADOTA os campos dos funis antes de
 *     projetar (nada some), e chave de contato e de negócio iguais nunca se fundem;
 *  6. `authenticated` só lê a tabela; `config` tem teto de tamanho; 50 definições por entidade.
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
    expect(como("authenticated", ATENDENTE_A, "update public.custom_field_definitions set label = 'H' returning id;")).toMatch(
      /permission denied/,
    );
  });

  it("o gerente de A não grava na organização B (with check)", () => {
    expect(
      como(
        "authenticated",
        GERENTE_A,
        `insert into public.custom_field_definitions (organization_id, entidade, key, label, type) values ('${ORG_B}', 'negocio', 'invasor', 'X', 'text');`,
      ),
    ).toMatch(/permission denied|row-level security/);
  });

  it("authenticated só tem SELECT: nem o gerente grava pela REST (o app grava pela service role)", () => {
    expect(sql("select has_table_privilege('authenticated', 'public.custom_field_definitions', 'select');")).toBe("t");
    for (const op of ["insert", "update", "delete"]) {
      expect(sql(`select has_table_privilege('authenticated', 'public.custom_field_definitions', '${op}');`)).toBe("f");
    }
    expect(
      como(
        "authenticated",
        GERENTE_A,
        `insert into public.custom_field_definitions (organization_id, entidade, key, label, type) values ('${ORG_A}', 'negocio', 'pela_rest', 'X', 'text');`,
      ),
    ).toMatch(/permission denied/);
    expect(
      sql("select has_function_privilege('authenticated', 'public.fn_adotar_campos_legados_da_organizacao(uuid)', 'execute');"),
    ).toBe("f");
    expect(sql("select has_function_privilege('anon', 'public.fn_adotar_campos_legados_da_organizacao(uuid)', 'execute');")).toBe(
      "f",
    );
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

  it("o conflito (tipo e maiúsculas de `cidade` entre os funis) fica GRAVADO na organização", () => {
    const conflitos = JSON.parse(
      sql(`select settings->'campos_conflitos' from public.organizations where id = '${ORG_LEGADO}';`),
    ) as Array<{ chave: string; diferenca: string[]; funis: Array<{ id: string }>; resolucao: string }>;
    const cidade = conflitos.find((c) => c.chave === "cidade");
    expect(cidade?.diferenca).toEqual(expect.arrayContaining(["tipo", "maiusculas"]));
    expect(cidade?.funis.map((f) => f.id)).toEqual([FUNIL_L1, FUNIL_L2]);
    expect(cidade?.resolucao).toBe("vale_o_funil_mais_antigo");
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

describe("a adoção do legado na primeira definição (sem perder fields)", () => {
  const ORG_D = "eeeeeeee-1015-4000-8000-00000000000d";
  const FUNIL_D = "eeeeeeee-1015-4000-8000-0000000000d1";

  beforeAll(() => {
    // Organização que ganhou campos pelo caminho antigo DEPOIS da migração: nenhuma definição.
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_D}', 'cp-inv-d', 'CP D', 'CP D') on conflict (id) do nothing;
      insert into public.crm_pipelines (id, organization_id, name, slug, settings) values
        ('${FUNIL_D}', '${ORG_D}', 'Legado', 'cp-legado-d',
         '{"fields": [{"key":"origem_lead","label":"Origem","type":"text","obrigatorio_em":{"ao_ganhar":true}},
                      {"key":"canal","label":"Canal","type":"select","options":[{"value":"a","label":"A"}]}]}')
        on conflict (id) do nothing;
    `);
  });

  it("criar a primeira definição adota os campos dos funis ANTES de projetar", () => {
    sql(
      `insert into public.custom_field_definitions (organization_id, entidade, key, label, type) values ('${ORG_D}', 'negocio', 'nova', 'Nova', 'text');`,
    );
    expect(
      sql(`select string_agg(key, ',' order by position, created_at) from public.custom_field_definitions where organization_id = '${ORG_D}';`),
    ).toBe("origem_lead,canal,nova");
    const fields = JSON.parse(sql(`select settings->'fields' from public.crm_pipelines where id = '${FUNIL_D}';`)) as Array<
      Record<string, unknown>
    >;
    expect(fields.map((f) => f.key).sort()).toEqual(["canal", "nova", "origem_lead"]);
    expect(fields.find((f) => f.key === "origem_lead")?.obrigatorio_em).toEqual({ ao_ganhar: true });
    expect(fields.find((f) => f.key === "canal")?.options).toEqual([{ value: "a", label: "A" }]);
    expect(sql(`select jsonb_array_length(settings->'campos_legados') from public.crm_pipelines where id = '${FUNIL_D}';`)).toBe("2");
  });

  it("chamar a adoção de novo não refaz nada (idempotente)", () => {
    expect(sql(`select public.fn_adotar_campos_legados_da_organizacao('${ORG_D}');`)).toBe("0");
    expect(sql(`select count(*) from public.custom_field_definitions where organization_id = '${ORG_D}';`)).toBe("3");
  });
});

describe("a mesma chave em contato e negócio nunca se funde", () => {
  const ORG_E = "eeeeeeee-1015-4000-8000-00000000000e";
  const FUNIL_E1 = "eeeeeeee-1015-4000-8000-0000000000e1";
  const FUNIL_E2 = "eeeeeeee-1015-4000-8000-0000000000e2";
  const CONTATO_E = "eeeeeeee-1015-4000-8000-0000000000e9";

  beforeAll(() => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_E}', 'cp-inv-e', 'CP E', 'CP E') on conflict (id) do nothing;
      insert into public.crm_pipelines (id, organization_id, name, slug, settings, created_at) values
        ('${FUNIL_E1}', '${ORG_E}', 'Negócio', 'cp-e-1', '{"fields": [{"key":"cidade","label":"Cidade","type":"text"}]}', now() - interval '2 days'),
        ('${FUNIL_E2}', '${ORG_E}', 'Contato', 'cp-e-2',
         '{"fields": [{"key":"cidade","label":"Cidade do contato","type":"text","escopo":"contato"}]}', now() - interval '1 day')
        on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, name, custom_fields) values
        ('${CONTATO_E}', '${ORG_E}', 'Pessoa E', '{"cidade": "Recife"}') on conflict (id) do nothing;
    `);
    sql(`select public.fn_adotar_campos_legados_da_organizacao('${ORG_E}');`);
  });

  it("a segunda entidade ganha chave própria, e o valor é COPIADO para ela (o antigo fica)", () => {
    expect(
      sql(`select string_agg(entidade || ':' || key, ',' order by position) from public.custom_field_definitions where organization_id = '${ORG_E}';`),
    ).toBe("negocio:cidade,contato:cidade_contato");
    expect(sql(`select custom_fields from public.contacts where id = '${CONTATO_E}';`)).toBe(
      '{"cidade": "Recife", "cidade_contato": "Recife"}',
    );
  });

  it("o conflito de entidade fica gravado com a chave nova", () => {
    const conflitos = JSON.parse(sql(`select settings->'campos_conflitos' from public.organizations where id = '${ORG_E}';`)) as Array<
      Record<string, unknown>
    >;
    expect(conflitos).toEqual([
      expect.objectContaining({
        chave: "cidade",
        chave_nova: "cidade_contato",
        diferenca: ["entidade"],
        resolucao: "chave_distinta_com_valores_copiados",
      }),
    ]);
  });
});

describe("os tetos do banco", () => {
  const ORG_F = "eeeeeeee-1015-4000-8000-00000000000f";

  beforeAll(() => {
    sql(`insert into public.organizations (id, slug, legal_name, display_name) values
           ('${ORG_F}', 'cp-inv-f', 'CP F', 'CP F') on conflict (id) do nothing;`);
  });

  it("config acima de 256 KB é recusado pelo CHECK", () => {
    expect(() =>
      sql(`insert into public.custom_field_definitions (organization_id, entidade, key, label, type, config)
           values ('${ORG_F}', 'negocio', 'grande', 'Grande', 'text',
                   jsonb_build_object('padrao', repeat('x', 300000)));`),
    ).toThrow(/custom_field_definitions_config_tamanho_check/);
  });

  it("50 definições por entidade; a 51ª é recusada e a outra entidade segue livre", () => {
    sql(`insert into public.custom_field_definitions (organization_id, entidade, key, label, type)
         select '${ORG_F}', 'negocio', 'campo_' || g, 'Campo ' || g, 'text' from generate_series(1, 50) g;`);
    expect(() =>
      sql(`insert into public.custom_field_definitions (organization_id, entidade, key, label, type)
           values ('${ORG_F}', 'negocio', 'campo_51', 'Campo 51', 'text');`),
    ).toThrow(/teto de campos personalizados/);
    sql(`insert into public.custom_field_definitions (organization_id, entidade, key, label, type)
         values ('${ORG_F}', 'contato', 'do_contato', 'Do contato', 'text');`);
    expect(sql(`select count(*) from public.custom_field_definitions where organization_id = '${ORG_F}';`)).toBe("51");
  });
});
