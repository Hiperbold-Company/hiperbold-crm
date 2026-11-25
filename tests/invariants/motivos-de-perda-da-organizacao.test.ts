import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * MOTIVOS DE PERDA DA ORGANIZAÇÃO (migration 1021).
 *
 * Medido no banco aplicado do baseline:
 *  1. a FUSÃO une as listas dos funis em `organizations.settings.lost_reasons` sem repetir rótulo
 *     (maiúsculas e espaços não contam), o funil mais antigo vence o conflito de categoria e o
 *     conflito fica GRAVADO em `motivos_conflitos`; acima de 50 o excedente vai para o mesmo lugar;
 *  2. reaplicar a migration não duplica, não reordena e não traz de volta o motivo apagado;
 *  3. o gatilho aceita canônico (inclusive `other`) ∪ organização ∪ legado do funil e recusa o resto;
 *  4. `fn_acrescentar_motivos_de_perda_da_organizacao` acrescenta sem apagar, respeita o teto e
 *     devolve `mudou = false` quando nada muda;
 *  5. as funções novas não são alcançáveis por anon nem por authenticated.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const MIGRATION = path.resolve(
  __dirname,
  "../../supabase/migrations/20261124150000_1021_motivos_de_perda_da_organizacao.sql",
);

const ORG_FUSAO = "10210000-0000-4000-8000-00000000000a";
const ORG_TETO = "10210000-0000-4000-8000-00000000000b";
const ORG_GATILHO = "10210000-0000-4000-8000-00000000000c";
const ORG_ACRESCENTA = "10210000-0000-4000-8000-00000000000d";
const ORG_ISOLA_A = "10210000-0000-4000-8000-00000000000e";
const ORG_ISOLA_B = "10210000-0000-4000-8000-00000000000f";

async function org(id: string, slug: string) {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1::uuid, $2::text, $2::text, $2::text)
     on conflict (id) do nothing`,
    [id, slug],
  );
  // O DO da migration pode ter rodado antes desta linha existir; o teste começa sem a chave.
  await pool.query(`update organizations set settings = settings - 'lost_reasons' - 'motivos_conflitos' where id = $1`, [id]);
}

async function funil(orgId: string, slug: string, motivos: unknown[], diasAtras: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position, settings, created_at)
     values ($1::uuid, $2::text, $2::text, 100, jsonb_build_object('lost_reasons', $3::jsonb), now() - make_interval(days => $4::int))
     returning id`,
    [orgId, slug, JSON.stringify(motivos), diasAtras],
  );
  return rows[0]!.id;
}

async function settingsDa(orgId: string): Promise<{ lost_reasons?: unknown[]; motivos_conflitos?: Array<Record<string, unknown>> }> {
  const { rows } = await pool.query<{ settings: Record<string, unknown> }>(`select settings from organizations where id = $1`, [
    orgId,
  ]);
  return rows[0]!.settings as never;
}

async function fundir(orgId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`select public.fn_fundir_motivos_de_perda_da_organizacao($1) as n`, [orgId]);
  return rows[0]!.n;
}

beforeAll(async () => {
  await org(ORG_FUSAO, "org-1021-fusao");
  await org(ORG_TETO, "org-1021-teto");
  await org(ORG_GATILHO, "org-1021-gatilho");
  await org(ORG_ACRESCENTA, "org-1021-acrescenta");
  await org(ORG_ISOLA_A, "org-1021-isola-a");
  await org(ORG_ISOLA_B, "org-1021-isola-b");
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1::uuid[])", [[ORG_FUSAO, ORG_TETO, ORG_GATILHO, ORG_ACRESCENTA, ORG_ISOLA_A, ORG_ISOLA_B]]);
  await pool.end();
});

describe("a fusão das listas dos funis", () => {
  beforeAll(async () => {
    await funil(ORG_FUSAO, "f1021-antigo", ["Preço alto", { label: "Sem orçamento", categoria: "Cliente" }], 3);
    await funil(ORG_FUSAO, "f1021-novo", [" preço  ALTO", { label: "sem orçamento", categoria: "Nós" }, "Concorrente"], 1);
    await fundir(ORG_FUSAO);
  });

  it("une sem repetir rótulo (maiúsculas e espaços não contam) e mantém a grafia do funil mais antigo", async () => {
    expect((await settingsDa(ORG_FUSAO)).lost_reasons).toEqual([
      "Preço alto",
      { label: "Sem orçamento", categoria: "Cliente" },
      "Concorrente",
    ]);
  });

  it("conflito de categoria: vence o funil mais antigo e a diferença fica gravada", async () => {
    const conflitos = (await settingsDa(ORG_FUSAO)).motivos_conflitos ?? [];
    expect(conflitos).toHaveLength(1);
    expect(conflitos[0]).toMatchObject({
      tipo: "categoria",
      motivo: "Sem orçamento",
      categoria_mantida: "Cliente",
      categoria_descartada: "Nós",
      funil: "f1021-novo",
    });
  });

  it("as listas dos funis ficam (legado aceito pelo gatilho)", async () => {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from crm_pipelines where organization_id = $1 and jsonb_array_length(settings->'lost_reasons') > 0`,
      [ORG_FUSAO],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("reaplicar a migration não duplica nem reordena", async () => {
    const antes = await settingsDa(ORG_FUSAO);
    await pool.query(readFileSync(MIGRATION, "utf8"));
    expect(await fundir(ORG_FUSAO)).toBe(0);
    const depois = await settingsDa(ORG_FUSAO);
    expect(depois.lost_reasons).toEqual(antes.lost_reasons);
    expect(depois.motivos_conflitos).toEqual(antes.motivos_conflitos);
  });

  it("o motivo que o administrador apagou não volta ao reaplicar", async () => {
    await pool.query(`update organizations set settings = settings || '{"lost_reasons": ["Concorrente"]}'::jsonb where id = $1`, [
      ORG_FUSAO,
    ]);
    await pool.query(readFileSync(MIGRATION, "utf8"));
    expect((await settingsDa(ORG_FUSAO)).lost_reasons).toEqual(["Concorrente"]);
  });

  it("organização sem funil com lista ganha a chave vazia (e não é fundida de novo)", async () => {
    await pool.query(`update organizations set settings = settings - 'lost_reasons' where id = $1`, [ORG_GATILHO]);
    expect(await fundir(ORG_GATILHO)).toBe(0);
    expect((await settingsDa(ORG_GATILHO)).lost_reasons).toEqual([]);
  });
});

describe("o teto de 50", () => {
  it("guarda os 50 primeiros e o excedente vai para motivos_conflitos — nada some", async () => {
    await funil(ORG_TETO, "f1021-teto-a", Array.from({ length: 30 }, (_, i) => `A${i}`), 2);
    await funil(ORG_TETO, "f1021-teto-b", Array.from({ length: 30 }, (_, i) => `B${i}`), 1);
    // O DO reaplicado no bloco anterior já deu a chave (vazia) a esta organização, sem funis então.
    await pool.query(`update organizations set settings = settings - 'lost_reasons' where id = $1`, [ORG_TETO]);
    expect(await fundir(ORG_TETO)).toBe(50);
    const s = await settingsDa(ORG_TETO);
    expect(s.lost_reasons).toHaveLength(50);
    expect(s.lost_reasons?.[49]).toBe("B19");
    const excedentes = (s.motivos_conflitos ?? []).filter((c) => c.tipo === "excedente").map((c) => c.motivo);
    expect(excedentes).toEqual(Array.from({ length: 10 }, (_, i) => `B${i + 20}`));
  });
});

describe("o gatilho do motivo da perda", () => {
  let funilGatilho = "";
  let etapaAberta = "";
  let etapaDePerda = "";

  beforeAll(async () => {
    funilGatilho = await funil(ORG_GATILHO, "f1021-gatilho", ["Só do funil"], 1);
    await pool.query(`update organizations set settings = settings || '{"lost_reasons": [{"label": "Da empresa", "categoria": "Nós"}]}'::jsonb where id = $1`, [
      ORG_GATILHO,
    ]);
    const etapa = async (slug: string, pos: number, perda: boolean) => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_lost)
         values ($1::uuid, $2::uuid, $3::text, $3::text, $4, $5) returning id`,
        [ORG_GATILHO, funilGatilho, slug, pos, perda],
      );
      return rows[0]!.id;
    };
    etapaAberta = await etapa("e1021-aberta", 1, false);
    etapaDePerda = await etapa("e1021-perdido", 2, true);
  });

  async function perderCom(motivo: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_leads (organization_id, pipeline_id, stage_id, title, status)
       values ($1, $2, $3, 'Negócio', 'open') returning id`,
      [ORG_GATILHO, funilGatilho, etapaAberta],
    );
    const { rows: depois } = await pool.query<{ status: string }>(
      `update crm_leads set stage_id = $2, lost_reason = $3 where id = $1 returning status`,
      [rows[0]!.id, etapaDePerda, motivo],
    );
    return depois[0]!.status;
  }

  it("aceita o motivo da organização", async () => {
    expect(await perderCom("Da empresa")).toBe("lost");
  });

  it("aceita o motivo legado do funil (transição)", async () => {
    expect(await perderCom("Só do funil")).toBe("lost");
  });

  it("aceita os canônicos, inclusive `other`", async () => {
    expect(await perderCom("other")).toBe("lost");
    expect(await perderCom("price")).toBe("lost");
  });

  it("recusa o que não está em lista nenhuma — 22023", async () => {
    await expect(perderCom("Inventado")).rejects.toMatchObject({ code: "22023" });
  });

  it("vale também para a sessão de um usuário (security definer)", async () => {
    const { rows } = await pool.query<{ prosecdef: boolean }>(
      `select prosecdef from pg_proc where oid = 'public.fn_validate_lost_reason_required()'::regprocedure`,
    );
    expect(rows[0]!.prosecdef).toBe(true);
  });
});

describe("isolamento entre duas empresas", () => {
  it("o motivo da empresa A é recusado num negócio da empresa B", async () => {
    await pool.query(`update organizations set settings = settings || '{"lost_reasons": ["Exclusivo da A"]}'::jsonb where id = $1`, [
      ORG_ISOLA_A,
    ]);
    await pool.query(`update organizations set settings = settings || '{"lost_reasons": ["Da B"]}'::jsonb where id = $1`, [ORG_ISOLA_B]);
    const funilB = await funil(ORG_ISOLA_B, "f1021-isola-b-gatilho", [], 1);
    const etapa = async (slug: string, pos: number, perda: boolean) => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_lost)
         values ($1::uuid, $2::uuid, $3::text, $3::text, $4, $5) returning id`,
        [ORG_ISOLA_B, funilB, slug, pos, perda],
      );
      return rows[0]!.id;
    };
    const aberta = await etapa("e1021-isola-aberta", 1, false);
    const perdido = await etapa("e1021-isola-perdido", 2, true);
    const novoNegocio = async () =>
      (
        await pool.query<{ id: string }>(
          `insert into crm_leads (organization_id, pipeline_id, stage_id, title, status)
           values ($1, $2, $3, 'Negócio B', 'open') returning id`,
          [ORG_ISOLA_B, funilB, aberta],
        )
      ).rows[0]!.id;
    const perder = (id: string, motivo: string) =>
      pool.query(`update crm_leads set stage_id = $2, lost_reason = $3 where id = $1`, [id, perdido, motivo]);

    await expect(perder(await novoNegocio(), "Exclusivo da A")).rejects.toMatchObject({ code: "22023" });
    // controle: o motivo da própria B passa no mesmo funil
    await expect(perder(await novoNegocio(), "Da B")).resolves.toBeDefined();
  });

  it("a fusão da empresa A não lê funil da empresa B", async () => {
    await pool.query(`update organizations set settings = settings - 'lost_reasons' where id = $1`, [ORG_ISOLA_A]);
    await pool.query(`update organizations set settings = settings || '{"lost_reasons": ["Da B"]}'::jsonb where id = $1`, [ORG_ISOLA_B]);
    await funil(ORG_ISOLA_A, "f1021-isola-a-fusao", ["Só da A"], 2);
    await funil(ORG_ISOLA_B, "f1021-isola-b-fusao", ["Só da B"], 3);
    await fundir(ORG_ISOLA_A);
    expect((await settingsDa(ORG_ISOLA_A)).lost_reasons).toEqual(["Só da A"]);
    expect((await settingsDa(ORG_ISOLA_B)).lost_reasons).toEqual(["Da B"]);
  });
});

describe("acrescentar à lista da organização", () => {
  async function acrescentar(motivos: unknown[]) {
    const { rows } = await pool.query<{ r: { lista: unknown[]; mudou: boolean; nao_couberam: unknown[] } }>(
      `select public.fn_acrescentar_motivos_de_perda_da_organizacao($1, $2::jsonb) as r`,
      [ORG_ACRESCENTA, JSON.stringify(motivos)],
    );
    return rows[0]!.r;
  }

  it("acrescenta sem apagar, não duplica rótulo e a categoria informada substitui", async () => {
    await pool.query(`update organizations set settings = settings || '{"lost_reasons": ["Preço", "Prazo"]}'::jsonb where id = $1`, [
      ORG_ACRESCENTA,
    ]);
    const r = await acrescentar([" preço ", { label: "prazo", categoria: "Nós" }, "Novo"]);
    expect(r.mudou).toBe(true);
    expect(r.lista).toEqual(["Preço", { label: "Prazo", categoria: "Nós" }, "Novo"]);
    expect((await settingsDa(ORG_ACRESCENTA)).lost_reasons).toEqual(r.lista);
  });

  it("nada novo: mudou = false", async () => {
    const r = await acrescentar(["PREÇO"]);
    expect(r.mudou).toBe(false);
  });

  it("acima de 50, o que não cabe volta em nao_couberam", async () => {
    const r = await acrescentar(Array.from({ length: 49 }, (_, i) => `X${i}`));
    expect(r.lista).toHaveLength(50);
    expect(r.nao_couberam).toHaveLength(2);
  });
});

describe("permissões", () => {
  it("anon e authenticated não executam as funções novas nem o gatilho", async () => {
    for (const fn of [
      "public.fn_fundir_motivos_de_perda_da_organizacao(uuid)",
      "public.fn_acrescentar_motivos_de_perda_da_organizacao(uuid, jsonb)",
      "public.fn_motivo_de_perda_normalizado(text)",
      "public.fn_validate_lost_reason_required()",
    ]) {
      for (const papel of ["anon", "authenticated"]) {
        const { rows } = await pool.query<{ pode: boolean }>(`select has_function_privilege($1, $2, 'execute') as pode`, [papel, fn]);
        expect(rows[0]!.pode, `${papel} executa ${fn}`).toBe(false);
      }
    }
  });
});
