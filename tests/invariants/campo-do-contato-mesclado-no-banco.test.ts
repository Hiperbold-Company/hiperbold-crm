/**
 * `fn_contato_anotar_campos` (migration 1024): o agente grava a resposta do
 * cliente no CONTATO sem apagar a edição feita ao mesmo tempo. O espelho, para
 * o contato, de `anotacao-simultanea-nao-apaga-a-outra.test.ts`.
 *
 * SABOTAGEM: trocar a função por "ler o mapa e gravar o objeto inteiro" faz o
 * primeiro caso perder a chave de A; tirar o `organization_id = p_org` faz o
 * de outra organização gravar; tirar o revoke faz anon/authenticated executarem.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
afterAll(() => pool.end());

async function fixture(customFields: Record<string, unknown> = {}) {
  const org = randomUUID();
  const contato = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Contato','Contato')",
    [org],
  );
  await pool.query("insert into contacts(id,organization_id,display_name,custom_fields) values($1,$2,'Cliente',$3)", [
    contato,
    org,
    customFields,
  ]);
  return { org, contato };
}

const anotar = "select public.fn_contato_anotar_campos($1,$2,$3::jsonb) as campos";
const ler = async (contato: string) =>
  (await pool.query("select custom_fields from contacts where id=$1", [contato])).rows[0].custom_fields;

it("a segunda escrita ESPERA a primeira confirmar e soma em cima dela", async () => {
  const f = await fixture({ cidade: "Recife" });
  const a = await pool.connect();
  const b = await pool.connect();
  const observer = await pool.connect();
  const bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
  try {
    await a.query("begin; set local statement_timeout='10s'");
    await b.query("begin; set local statement_timeout='10s'");
    await a.query(anotar, [f.org, f.contato, JSON.stringify({ interesse: "moradia" })]);
    const pendente = b.query(anotar, [f.org, f.contato, JSON.stringify({ visitou: true })]);
    await expect
      .poll(
        async () =>
          (await observer.query("select wait_event_type from pg_stat_activity where pid=$1", [bpid])).rows[0]
            ?.wait_event_type === "Lock",
        { timeout: 5000, interval: 20 },
      )
      .toBe(true);
    await a.query("commit");
    const resposta = await pendente;
    await b.query("commit");
    expect(resposta.rows[0].campos).toEqual({ cidade: "Recife", interesse: "moradia", visitou: true });
    expect(await ler(f.contato)).toEqual({ cidade: "Recife", interesse: "moradia", visitou: true });
  } finally {
    await a.query("rollback").catch(() => undefined);
    await b.query("rollback").catch(() => undefined);
    a.release();
    b.release();
    observer.release();
  }
});

it("contato de OUTRA organização devolve null e não grava nada", async () => {
  const dono = await fixture({ intacto: "sim" });
  const outra = await fixture();
  const r = await pool.query(anotar, [outra.org, dono.contato, JSON.stringify({ invasor: "x" })]);
  expect(r.rows[0].campos).toBeNull();
  expect(await ler(dono.contato)).toEqual({ intacto: "sim" });
});

it("recusa quem não manda um objeto", async () => {
  const f = await fixture();
  for (const invalido of ["[1,2]", '"texto"', "null"]) {
    await expect(pool.query(anotar, [f.org, f.contato, invalido])).rejects.toMatchObject({ code: "22023" });
  }
});

it("nem anon nem authenticated executam a função — só service_role", async () => {
  const f = await fixture();
  for (const papel of ["anon", "authenticated"]) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${papel}`);
      await expect(c.query(anotar, [f.org, f.contato, "{}"])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("rollback");
      c.release();
    }
  }
});
