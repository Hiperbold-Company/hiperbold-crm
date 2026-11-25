import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A MOEDA POR CAMPO CHEGA ÀS FICHAS (migration 1022).
 *
 * As telas leem `crm_pipelines.settings.fields`, que o banco deriva de `custom_field_definitions`.
 * Antes da 1022 a projeção copiava só seis chaves do `config`; `moeda` ficava de fora e o campo em
 * dólar aparecia na moeda da organização. Medido no banco aplicado do baseline.
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

const ORG = "eeeeeeee-1022-4000-8000-00000000000a";
const FUNIL = "eeeeeeee-1022-4000-8000-0000000000f1";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'moeda-inv-a', 'Moeda A', 'Moeda A') on conflict (id) do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug, settings) values
      ('${FUNIL}', '${ORG}', 'Vendas', 'moeda-vendas-a', '{"fields": []}') on conflict (id) do nothing;
    insert into public.custom_field_definitions (organization_id, entidade, key, label, type, config) values
      ('${ORG}', 'negocio', 'invest_usd', 'Investimento', 'currency', '{"moeda": "USD"}'),
      ('${ORG}', 'negocio', 'invest_org', 'Valor', 'currency', '{}')
      on conflict do nothing;
  `);
});

function campos(): Array<Record<string, unknown>> {
  return JSON.parse(sql(`select settings->'fields' from public.crm_pipelines where id = '${FUNIL}';`));
}

describe("a projeção leva config.moeda ao settings.fields", () => {
  it("campo com moeda USD sai com moeda USD", () => {
    expect(campos().find((f) => f.key === "invest_usd")?.moeda).toBe("USD");
  });

  it("campo sem moeda não ganha a chave (ausência = moeda da organização)", () => {
    const f = campos().find((x) => x.key === "invest_org");
    expect(f).toBeDefined();
    expect(f).not.toHaveProperty("moeda");
  });

  it("trocar a moeda da definição reprojeta o funil", () => {
    sql(`update public.custom_field_definitions set config = '{"moeda": "EUR"}' where organization_id = '${ORG}' and key = 'invest_usd';`);
    expect(campos().find((f) => f.key === "invest_usd")?.moeda).toBe("EUR");
  });
});

describe("a adoção do legado também copia a moeda", () => {
  it("fn_adotar_campos_legados_da_organizacao lista `moeda` em c_props", () => {
    expect(sql(`select pg_get_functiondef('public.fn_adotar_campos_legados_da_organizacao(uuid)'::regprocedure) like '%''multiple'', ''moeda''%';`)).toBe("t");
  });
});
