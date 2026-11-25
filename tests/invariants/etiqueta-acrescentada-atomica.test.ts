/**
 * Migration 1023: `fn_acrescentar_etiqueta_ao_vocabulario` acrescenta UMA etiqueta a
 * `organizations.settings.tags` com a linha travada. Antes, "Nova etiqueta" lia a lista e a
 * regravava inteira: duas criações simultâneas perdiam uma. Contra o banco que o self-host instala,
 * com sessões de verdade concorrentes.
 *
 * Roda via `pnpm test:db tests/invariants/etiqueta-acrescentada-atomica.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 16,
});

const org = randomUUID();
const outraOrg = randomUUID();

const acrescentar = async (nome: string, cor: string | null = null, teto = 200, o = org): Promise<string> =>
  (
    await pool.query("select public.fn_acrescentar_etiqueta_ao_vocabulario($1,$2,$3,$4) as s", [o, nome, cor, teto])
  ).rows[0].s;

const tags = async (o = org): Promise<unknown[]> =>
  (await pool.query("select coalesce(settings->'tags','[]'::jsonb) as t from organizations where id=$1", [o])).rows[0].t;

beforeAll(async () => {
  for (const id of [org, outraOrg])
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')", [id]);
});
afterAll(async () => {
  await pool.end();
});

describe("1023: fn_acrescentar_etiqueta_ao_vocabulario", () => {
  it("acrescenta com e sem cor, e preserva as outras chaves de settings", async () => {
    await pool.query(`update organizations set settings='{"routing":{"x":1},"tags":["antiga"]}'::jsonb where id=$1`, [org]);
    expect(await acrescentar("  Nova ", "#00ff00")).toBe("criada");
    expect(await acrescentar("sem-cor")).toBe("criada");
    expect(await tags()).toEqual(["antiga", { tag: "nova", cor: "#00ff00" }, { tag: "sem-cor" }]);
    const { rows } = await pool.query("select settings->'routing' as r from organizations where id=$1", [org]);
    expect(rows[0].r).toEqual({ x: 1 });
  });

  it("repetida (caixa, aparo, forma de texto ou objeto) é ja_existe e não grava", async () => {
    expect(await acrescentar("ANTIGA")).toBe("ja_existe");
    expect(await acrescentar("NOVA ")).toBe("ja_existe");
    expect(await tags()).toHaveLength(3);
  });

  it("no teto devolve limite; organização inexistente devolve organizacao_nao_encontrada", async () => {
    expect(await acrescentar("mais-uma", null, 3)).toBe("limite");
    expect(await acrescentar("x", null, 200, randomUUID())).toBe("organizacao_nao_encontrada");
  });

  it("settings nulo e tags que não é lista viram lista nova", async () => {
    await pool.query(`update organizations set settings='{"tags":"lixo"}'::jsonb where id=$1`, [outraOrg]);
    expect(await acrescentar("a", null, 200, outraOrg)).toBe("criada");
    expect(await tags(outraOrg)).toEqual([{ tag: "a" }]);
  });

  it("40 criações simultâneas: nenhuma se perde; 20 repetidas simultâneas gravam uma só", async () => {
    await pool.query("update organizations set settings='{}'::jsonb where id=$1", [org]);
    const r = await Promise.all(Array.from({ length: 40 }, (_, i) => acrescentar(`t${i}`)));
    expect(r.every((s) => s === "criada")).toBe(true);
    expect(await tags()).toHaveLength(40);
    const d = await Promise.all(Array.from({ length: 20 }, () => acrescentar("igual")));
    expect(d.filter((s) => s === "criada")).toHaveLength(1);
    expect(d.filter((s) => s === "ja_existe")).toHaveLength(19);
    expect(await tags()).toHaveLength(41);
  });

  it("só o servidor executa: anon e authenticated não têm EXECUTE", async () => {
    const f = "fn_acrescentar_etiqueta_ao_vocabulario(uuid,text,text,integer)";
    const { rows } = await pool.query(`select
      has_function_privilege('anon','${f}','execute') as anon,
      has_function_privilege('authenticated','${f}','execute') as membro,
      has_function_privilege('service_role','${f}','execute') as servidor`);
    expect(rows[0]).toEqual({ anon: false, membro: false, servidor: true });
  });
});
