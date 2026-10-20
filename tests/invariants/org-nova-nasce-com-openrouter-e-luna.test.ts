/**
 * Migration 0973 (decisão do dono, 20/10/2026): organização nova nasce com a IA da instalação —
 * provedor `openrouter` e o PRIMEIRO modelo de `platform_config.MODELOS_DA_INSTALACAO` (Luna). Antes,
 * o gatilho `trg_seed_org_llm_defaults` semeava `anthropic` + o curado da Anthropic.
 *
 * Contra o banco que o self-host instala (baseline em install E update).
 * Roda via `pnpm test:db tests/invariants/org-nova-nasce-com-openrouter-e-luna.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.query("delete from platform_config where chave = 'MODELOS_DA_INSTALACAO'");
  await pool.end();
});

beforeEach(async () => {
  await pool.query("delete from platform_config where chave = 'MODELOS_DA_INSTALACAO'");
});

async function novaOrg(settings?: unknown): Promise<{ provider?: string; default_model?: string; [k: string]: unknown }> {
  const id = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name,settings) values($1::uuid,$1::text,'Teste','Teste',coalesce($2::jsonb,'{}'::jsonb))",
    [id, settings === undefined ? null : JSON.stringify(settings)],
  );
  const { rows } = await pool.query("select settings->'llm' as llm from organizations where id=$1", [id]);
  return rows[0].llm;
}

describe("organização nova: padrão de IA da instalação", () => {
  it("sem lista configurada, nasce em OpenRouter + Luna (nunca Anthropic)", async () => {
    const llm = await novaOrg();
    expect(llm).toMatchObject({ provider: "openrouter", default_model: "openai/gpt-6-luna" });
  });

  it("com MODELOS_DA_INSTALACAO configurada, o PRIMEIRO da lista é o padrão", async () => {
    await pool.query(
      "insert into platform_config(chave, valor, eh_segredo) values('MODELOS_DA_INSTALACAO', $1, false)",
      ["google/gemini-flash, openai/gpt-6-luna"],
    );
    const llm = await novaOrg();
    expect(llm).toMatchObject({ provider: "openrouter", default_model: "google/gemini-flash" });
  });

  it("lista em '*' (freio desligado) vale o literal Luna, nunca o asterisco", async () => {
    await pool.query("insert into platform_config(chave, valor, eh_segredo) values('MODELOS_DA_INSTALACAO', '*', false)");
    const llm = await novaOrg();
    expect(llm.default_model).toBe("openai/gpt-6-luna");
  });

  it("organização que já traz o par escolhido (instalador, provisionamento) não é sobrescrita", async () => {
    const llm = await novaOrg({ llm: { provider: "openai", default_model: "gpt-5-mini" } });
    expect(llm).toMatchObject({ provider: "openai", default_model: "gpt-5-mini" });
  });

  it("a função do gatilho não fica alcançável pela anon key", async () => {
    const { rows } = await pool.query(
      "select has_function_privilege('anon', 'public.fn_seed_org_llm_defaults()', 'execute') as anon",
    );
    expect(rows[0].anon).toBe(false);
  });
});
