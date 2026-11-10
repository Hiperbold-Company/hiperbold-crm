import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Migration 1005 — converter uma regra antiga em automação, numa transação só.
 *
 * O que só um Postgres de verdade responde:
 *  - `fn_automacao_converter_regra` desliga a regra, grava `migrated_to_pointer_id` e publica a
 *    versão do ponteiro na MESMA transação (nunca fica "regra desligada e automação sem versão");
 *  - os dois gatilhos fecham o "dois motores ligados" pelos dois lados, com PT409;
 *  - a função é só da service role e não atravessa organizações.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ORG_A = "a1005000-0000-4000-8000-00000000000a";
const ORG_B = "a1005000-0000-4000-8000-00000000000b";

const GRAFO = JSON.stringify({
  nodes: [
    { id: "t1", type: "trigger", label: "i", position: { x: 0, y: 0 }, config: {} },
    {
      id: "e1",
      type: "end",
      label: "f",
      position: { x: 0, y: 0 },
      config: { outcome: "converted" },
    },
  ],
  edges: [{ id: "a", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
});

async function limpar(): Promise<void> {
  // `on delete cascade` leva regras, ponteiros e versões junto.
  await pool.query(`delete from organizations where id in ($1, $2)`, [ORG_A, ORG_B]);
}

beforeEach(async () => {
  await limpar();
  for (const [id, slug] of [
    [ORG_A, "conv-regra-a"],
    [ORG_B, "conv-regra-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name) values ($1::uuid, $2::text, $2::text, $2::text)`,
      [id, slug],
    );
  }
});

afterAll(async () => {
  await limpar();
  await pool.end();
});

async function semearRegra(org: string, ativa = true): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into automation_rules (organization_id, name, trigger_event, is_active)
     values ($1, 'Regra ' || gen_random_uuid(), 'lead.created', $2) returning id`,
    [org, ativa],
  );
  return rows[0]!.id;
}

async function semearAutomacao(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, surface)
     values ($1, 'Automacao ' || gen_random_uuid(), 'draft', 'automacao') returning id`,
    [org],
  );
  return rows[0]!.id;
}

const converter = (org: string, regra: string, ponteiro: string, grafo: string | null = GRAFO) =>
  pool.query<{ v: string }>(
    `select fn_automacao_converter_regra($1, $2, $3, $4::jsonb, null) as v`,
    [org, regra, ponteiro, grafo],
  );

async function estado(regra: string, ponteiro: string) {
  const { rows: r } = await pool.query<{
    is_active: boolean;
    migrated_to_pointer_id: string | null;
  }>(`select is_active, migrated_to_pointer_id from automation_rules where id = $1`, [regra]);
  const { rows: p } = await pool.query<{ status: string; active_version_id: string | null }>(
    `select status, active_version_id from followup_flow_pointers where id = $1`,
    [ponteiro],
  );
  const { rows: v } = await pool.query<{ n: string }>(
    `select count(*) as n from followup_flow_versions where pointer_id = $1`,
    [ponteiro],
  );
  return { regra: r[0]!, ponteiro: p[0]!, versoes: Number(v[0]!.n) };
}

async function codigoDoErro(
  promessa: Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  try {
    await promessa;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? "" };
  }
  throw new Error("a operação deveria ter falhado e não falhou");
}

describe("fn_automacao_converter_regra (migration 1005)", () => {
  it("desliga a regra, grava o vínculo e publica o ponteiro na mesma transação", async () => {
    const regra = await semearRegra(ORG_A);
    const ponteiro = await semearAutomacao(ORG_A);

    const { rows } = await converter(ORG_A, regra, ponteiro);

    const e = await estado(regra, ponteiro);
    expect(e.regra).toEqual({ is_active: false, migrated_to_pointer_id: ponteiro });
    expect(e.ponteiro.status).toBe("active");
    expect(e.ponteiro.active_version_id).toBe(rows[0]!.v);
    expect(e.versoes).toBe(1);
  });

  it("falha na publicação desfaz tudo: a regra segue ligada e sem vínculo (rollback)", async () => {
    const regra = await semearRegra(ORG_A);
    const ponteiro = await semearAutomacao(ORG_A);

    // grafo nulo viola `followup_flow_versions.graph not null` DENTRO do publish.
    const erro = await codigoDoErro(converter(ORG_A, regra, ponteiro, null));
    expect(erro.code).toBe("23502");

    const e = await estado(regra, ponteiro);
    expect(e.regra).toEqual({ is_active: true, migrated_to_pointer_id: null });
    expect(e.ponteiro).toEqual({ status: "draft", active_version_id: null });
    expect(e.versoes).toBe(0);
  });

  it("chamada repetida não duplica: recusa 'rule_already_converted' e não publica outra versão", async () => {
    const regra = await semearRegra(ORG_A);
    const ponteiro = await semearAutomacao(ORG_A);
    await converter(ORG_A, regra, ponteiro);
    const antes = await estado(regra, ponteiro);

    const erro = await codigoDoErro(converter(ORG_A, regra, ponteiro));
    expect(erro.message).toMatch(/rule_already_converted/);

    expect(await estado(regra, ponteiro)).toEqual(antes);
  });

  it("organização B não converte a regra da A, nem usa o ponteiro da A", async () => {
    const regraA = await semearRegra(ORG_A);
    const ponteiroA = await semearAutomacao(ORG_A);
    const regraB = await semearRegra(ORG_B);
    const ponteiroB = await semearAutomacao(ORG_B);

    const e1 = await codigoDoErro(converter(ORG_B, regraA, ponteiroB));
    expect(e1.message).toMatch(/rule_not_found/);
    const e2 = await codigoDoErro(converter(ORG_B, regraB, ponteiroA));
    expect(e2.message).toMatch(/pointer_not_found/);

    expect((await estado(regraA, ponteiroA)).regra).toEqual({
      is_active: true,
      migrated_to_pointer_id: null,
    });
    expect(await estado(regraB, ponteiroB)).toEqual({
      regra: { is_active: true, migrated_to_pointer_id: null },
      ponteiro: { status: "draft", active_version_id: null },
      versoes: 0,
    });
  });

  it("ponteiro que não é automação é recusado", async () => {
    const regra = await semearRegra(ORG_A);
    const { rows } = await pool.query<{ id: string }>(
      `insert into followup_flow_pointers (organization_id, name, status, surface)
       values ($1, 'IA ' || gen_random_uuid(), 'draft', 'followup') returning id`,
      [ORG_A],
    );
    const erro = await codigoDoErro(converter(ORG_A, regra, rows[0]!.id));
    expect(erro.message).toMatch(/pointer_not_found/);
    expect((await estado(regra, rows[0]!.id)).regra.is_active).toBe(true);
  });

  it("só a service role executa: anon e authenticated são negados", async () => {
    const f = "public.fn_automacao_converter_regra(uuid, uuid, uuid, jsonb, uuid)";
    const { rows } = await pool.query<{
      anon: boolean;
      auth: boolean;
      service: boolean;
      pub: boolean;
    }>(
      `select has_function_privilege('anon', '${f}', 'execute') as anon,
              has_function_privilege('authenticated', '${f}', 'execute') as auth,
              has_function_privilege('service_role', '${f}', 'execute') as service,
              exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where p.oid = '${f}'::regprocedure and a.grantee = 0) as pub`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false, service: true, pub: false });

    // E de fato: chamar como anon/authenticated é "permission denied".
    for (const papel of ["anon", "authenticated"]) {
      const client = await pool.connect();
      try {
        await client.query(`set role ${papel}`);
        const erro = await codigoDoErro(
          client.query(`select fn_automacao_converter_regra($1, $1, $1, '{}'::jsonb, null)`, [
            ORG_A,
          ]),
        );
        expect(erro.code).toBe("42501");
      } finally {
        await client.query("reset role");
        client.release();
      }
    }
  });
});

describe("gatilhos de guarda: dois motores nunca ligados ao mesmo tempo (PT409)", () => {
  it("religar a regra convertida com a automação ligada: PT409; com a automação desligada: passa", async () => {
    const regra = await semearRegra(ORG_A);
    const ponteiro = await semearAutomacao(ORG_A);
    await converter(ORG_A, regra, ponteiro);

    const erro = await codigoDoErro(
      pool.query(`update automation_rules set is_active = true where id = $1`, [regra]),
    );
    expect(erro.code).toBe("PT409");
    expect((await estado(regra, ponteiro)).regra.is_active).toBe(false);

    await pool.query(`update followup_flow_pointers set status = 'disabled' where id = $1`, [
      ponteiro,
    ]);
    await pool.query(`update automation_rules set is_active = true where id = $1`, [regra]);
    expect((await estado(regra, ponteiro)).regra.is_active).toBe(true);
  });

  it("ligar a automação com a regra de origem ligada: PT409; com a regra desligada: passa", async () => {
    const regra = await semearRegra(ORG_A);
    const ponteiro = await semearAutomacao(ORG_A);
    await converter(ORG_A, regra, ponteiro);
    // volta atrás "à mão": desliga a automação e religa a regra.
    await pool.query(`update followup_flow_pointers set status = 'disabled' where id = $1`, [
      ponteiro,
    ]);
    await pool.query(`update automation_rules set is_active = true where id = $1`, [regra]);

    const erro = await codigoDoErro(
      pool.query(`update followup_flow_pointers set status = 'active' where id = $1`, [ponteiro]),
    );
    expect(erro.code).toBe("PT409");
    expect((await estado(regra, ponteiro)).ponteiro.status).toBe("disabled");

    await pool.query(`update automation_rules set is_active = false where id = $1`, [regra]);
    await pool.query(`update followup_flow_pointers set status = 'active' where id = $1`, [
      ponteiro,
    ]);
    expect((await estado(regra, ponteiro)).ponteiro.status).toBe("active");
  });

  it("regra comum (nunca convertida) liga e desliga livremente", async () => {
    const regra = await semearRegra(ORG_A, false);
    await pool.query(`update automation_rules set is_active = true where id = $1`, [regra]);
    const { rows } = await pool.query<{ is_active: boolean }>(
      `select is_active from automation_rules where id = $1`,
      [regra],
    );
    expect(rows[0]!.is_active).toBe(true);
  });

  it("apagar a automação devolve a regra à lista, desligada (on delete set null)", async () => {
    const regra = await semearRegra(ORG_A);
    const ponteiro = await semearAutomacao(ORG_A);
    await converter(ORG_A, regra, ponteiro);

    await pool.query(`delete from followup_flow_pointers where id = $1`, [ponteiro]);

    const { rows } = await pool.query<{
      is_active: boolean;
      migrated_to_pointer_id: string | null;
    }>(`select is_active, migrated_to_pointer_id from automation_rules where id = $1`, [regra]);
    expect(rows[0]).toEqual({ is_active: false, migrated_to_pointer_id: null });
  });
});
