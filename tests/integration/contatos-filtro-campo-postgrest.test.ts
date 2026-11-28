// @vitest-environment node
/**
 * As condições do filtro por campo personalizado contra um PostgREST REAL (não o dublê em memória).
 *
 * O que só o PostgREST de verdade responde, e o dublê de `tests/unit/helpers/supabase-em-memoria.ts`
 * apenas imita: o anti-join `.is("lc", null)` ao lado do `lf` inner; `is.null` e `not.<op>` sobre
 * `custom_fields->>k` dentro do `.or()`; `regexMatch`/`regexIMatch` em coluna de junção; e o
 * desescape de `\` na regex entre aspas.
 *
 * Grava num banco de verdade, então NÃO roda por acaso: só com `TESTE_POSTGREST_REAL=1` e uma URL
 * de Supabase em `127.0.0.1`/`localhost` (o banco de desenvolvimento, pelo túnel). Sem isso, pula —
 * o `test:unit` do CI e o de quem tem `.env.local` não tocam banco nenhum.
 *
 *   TESTE_POSTGREST_REAL=1 NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     pnpm exec vitest run tests/integration/contatos-filtro-campo-postgrest.test.ts
 *
 * Cria duas organizações (prefixo de slug próprio, que também apaga sobra de rodada abortada) e
 * apaga as duas no fim — contatos, funis e negócios vão junto pelo `on delete cascade`.
 *
 * O esperado de cada caso é escrito à mão a partir da tabela de dados abaixo, pela semântica
 * combinada: vazio conta como "não contém"/"diferente"; nas negativas de "negócio" e "os dois",
 * NENHUM negócio do recorte pode ter o valor; com funil, o contato precisa ter negócio no funil.
 */
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contarContatos, idsDoFiltro } from "@/lib/contacts/consulta";
import { filtrosDeContatosSchema } from "@/lib/schemas/contacts";

const URL_DO_BANCO = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const CHAVE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const LIGADO =
  process.env.TESTE_POSTGREST_REAL === "1" &&
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(URL_DO_BANCO) &&
  CHAVE.length > 0;

const PREFIXO = "teste-filtro-campo-pgrst-";
const CAMPO = "cargo";

/**
 * Os contatos da organização A. `c` = o campo no contato (`undefined` = a chave nem existe);
 * `f1`/`f2` = o campo em cada negócio do funil 1 / 2 (`undefined` = negócio sem a chave).
 */
const FIXTURE: Record<number, { c?: string | null; f1?: Array<string | undefined>; f2?: Array<string | undefined> }> = {
  1: { c: "Gerente" }, // valor só no contato, sem negócio
  2: { f1: ["Gerente"] }, // valor só no negócio
  3: { c: "Gerente", f1: ["Gerente"] }, // valor nos dois
  4: { c: "", f1: [undefined] }, // vazio "" no contato; negócio sem a chave
  5: { c: "   " }, // só espaços, sem negócio
  6: {}, // campo ausente, sem negócio
  7: { c: null, f1: ["Gerente", undefined] }, // null explícito; 2 negócios, um com valor e outro sem
  8: { f2: ["Gerente"], f1: [""] }, // valor só num negócio de OUTRO funil
  9: { c: "Diretora, Vendas", f1: ["Vendedor (Sr.)"] }, // vírgula e parênteses
  10: { c: 'Ana "A+"', f1: ["a.b"] }, // aspas e metacaracteres
  11: { c: "axb", f2: ["c++"] }, // isca do "." literal; "+" no negócio
  12: { c: "Coordenador", f2: ["   "] }, // negócio só com espaços
  13: { c: "Gerente Comercial" }, // separa "contém" de "é igual a"
  14: { f2: ['Ana "A+"'] }, // valor só num negócio do funil 2
};

/** A organização B: os MESMOS valores. Nada dela pode aparecer nunca. */
const FIXTURE_B: Array<{ c?: string | null; l?: Array<string | undefined> }> = [
  { c: "Gerente", l: ["Gerente"] },
  { c: "" },
  {},
  { c: "Diretora, Vendas", l: ["Vendedor (Sr.)"] },
  { c: 'Ana "A+"', l: ["a.b", "c++"] },
  { l: ["   "] },
];

const QUALQUER_DE_ESPECIAIS = 'Diretora\\, Vendas, vendedor (sr.), a.b, ana "a+"';

type Escopo = "contato" | "negocio" | "qualquer";
type Caso = { op: string; valor?: string; escopo: Escopo; funil: boolean; esperado: number[] };

/** Esperado à mão: [op, valor, escopo, sem funil, com funil 1]. */
const TABELA: Array<[string, string | undefined, Escopo, number[], number[]]> = [
  ["contem", "gerente", "contato", [1, 3, 13], [3]],
  ["contem", "gerente", "negocio", [2, 3, 7, 8], [2, 3, 7]],
  ["contem", "gerente", "qualquer", [1, 2, 3, 7, 8, 13], [2, 3, 7]],
  ["nao_contem", "gerente", "contato", [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14], [2, 4, 7, 8, 9, 10]],
  ["nao_contem", "gerente", "negocio", [4, 9, 10, 11, 12, 14], [4, 8, 9, 10]],
  ["nao_contem", "gerente", "qualquer", [4, 5, 6, 9, 10, 11, 12, 14], [4, 8, 9, 10]],
  ["igual", "gerente", "contato", [1, 3], [3]],
  ["igual", "gerente", "negocio", [2, 3, 7, 8], [2, 3, 7]],
  ["igual", "gerente", "qualquer", [1, 2, 3, 7, 8], [2, 3, 7]],
  ["diferente", "gerente", "contato", [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], [2, 4, 7, 8, 9, 10]],
  ["diferente", "gerente", "negocio", [4, 9, 10, 11, 12, 14], [4, 8, 9, 10]],
  ["diferente", "gerente", "qualquer", [4, 5, 6, 9, 10, 11, 12, 13, 14], [4, 8, 9, 10]],
  ["preenchido", undefined, "contato", [1, 3, 9, 10, 11, 12, 13], [3, 9, 10]],
  ["preenchido", undefined, "negocio", [2, 3, 7, 8, 9, 10, 11, 14], [2, 3, 7, 9, 10]],
  ["preenchido", undefined, "qualquer", [1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14], [2, 3, 7, 9, 10]],
  ["vazio", undefined, "contato", [2, 4, 5, 6, 7, 8, 14], [2, 4, 7, 8]],
  ["vazio", undefined, "negocio", [4, 12], [4, 8]],
  ["vazio", undefined, "qualquer", [4, 5, 6], [4, 8]],
  ["qualquer_de", QUALQUER_DE_ESPECIAIS, "contato", [9, 10], [9, 10]],
  ["qualquer_de", QUALQUER_DE_ESPECIAIS, "negocio", [9, 10, 14], [9, 10]],
  ["qualquer_de", QUALQUER_DE_ESPECIAIS, "qualquer", [9, 10, 14], [9, 10]],
  // Só o contato tem estes valores (o negócio 14 é do funil 2): 9 e 10 entram SÓ pelo lado do `or`,
  // onde o valor vai entre aspas com `"` escapado.
  ["qualquer_de", 'ana "a+", Diretora\\, Vendas', "contato", [9, 10], [9, 10]],
  ["qualquer_de", 'ana "a+", Diretora\\, Vendas', "negocio", [14], []],
  ["qualquer_de", 'ana "a+", Diretora\\, Vendas', "qualquer", [9, 10, 14], [9, 10]],
  ["diferente", 'ana "a+"', "contato", [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14], [2, 3, 4, 7, 8, 9]],
  ["diferente", 'ana "a+"', "qualquer", [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13], [2, 3, 4, 7, 8, 9]],
  ["qualquer_de", "c++, gerente", "contato", [1, 3], [3]],
  ["qualquer_de", "c++, gerente", "negocio", [2, 3, 7, 8, 11], [2, 3, 7]],
  ["qualquer_de", "c++, gerente", "qualquer", [1, 2, 3, 7, 8, 11], [2, 3, 7]],
];

const CASOS: Caso[] = TABELA.flatMap(([op, valor, escopo, semFunil, comFunil]) => [
  { op, valor, escopo, funil: false, esperado: semFunil },
  { op, valor, escopo, funil: true, esperado: comFunil },
]);

describe.skipIf(!LIGADO)("filtro de campo contra PostgREST real", () => {
  let db: SupabaseClient;
  let orgA = "";
  let orgB = "";
  const funil1 = randomUUID();
  const funil2 = randomUUID();
  const funilB = randomUUID();
  /** número da fixture → id do contato na org A. */
  const idDe = new Map<number, string>();
  const idsDeB = new Set<string>();

  const campos = (v: string | null | undefined) => (v === undefined ? {} : { [CAMPO]: v });

  async function apagarOrgsDoTeste() {
    const { data, error } = await db.from("organizations").select("id").like("slug", `${PREFIXO}%`);
    if (error) throw error;
    const ids = (data ?? []).map((o) => o.id as string);
    if (ids.length === 0) return;
    const apagou = await db.from("organizations").delete().in("id", ids);
    if (apagou.error) throw apagou.error;
  }

  async function criarOrg(rotulo: string): Promise<string> {
    const sufixo = randomUUID().slice(0, 8);
    const org = await db
      .from("organizations")
      .insert({ slug: `${PREFIXO}${rotulo}-${sufixo}`, display_name: `Teste filtro ${rotulo}`, legal_name: "Teste" })
      .select("id")
      .single();
    if (org.error) throw org.error;
    return org.data.id as string;
  }

  async function criarFunil(org: string, id: string): Promise<string> {
    const p = await db.from("crm_pipelines").insert({ id, organization_id: org, name: `Funil ${id.slice(0, 4)}`, slug: `f-${id.slice(0, 8)}` });
    if (p.error) throw p.error;
    const etapa = randomUUID();
    const s = await db
      .from("crm_stages")
      .insert({ id: etapa, organization_id: org, pipeline_id: id, name: "Novo", slug: "novo", position: 1 });
    if (s.error) throw s.error;
    return etapa;
  }

  async function criarContato(org: string, n: string, c: string | null | undefined): Promise<string> {
    const r = await db
      .from("contacts")
      .insert({ organization_id: org, name: `Contato ${n}`, custom_fields: campos(c) })
      .select("id")
      .single();
    if (r.error) throw r.error;
    return r.data.id as string;
  }

  async function criarNegocios(org: string, contato: string, funil: string, etapa: string, valores: Array<string | undefined>) {
    if (valores.length === 0) return;
    const r = await db.from("crm_leads").insert(
      valores.map((v, i) => ({
        organization_id: org,
        pipeline_id: funil,
        stage_id: etapa,
        contact_id: contato,
        title: `Negócio ${i}`,
        custom_fields: campos(v),
      })),
    );
    if (r.error) throw r.error;
  }

  beforeAll(async () => {
    db = createClient(URL_DO_BANCO, CHAVE, { auth: { persistSession: false, autoRefreshToken: false } });
    await apagarOrgsDoTeste();
    orgA = await criarOrg("a");
    orgB = await criarOrg("b");
    const etapa1 = await criarFunil(orgA, funil1);
    const etapa2 = await criarFunil(orgA, funil2);
    const etapaB = await criarFunil(orgB, funilB);
    for (const [n, linha] of Object.entries(FIXTURE)) {
      const id = await criarContato(orgA, n, linha.c);
      idDe.set(Number(n), id);
      await criarNegocios(orgA, id, funil1, etapa1, linha.f1 ?? []);
      await criarNegocios(orgA, id, funil2, etapa2, linha.f2 ?? []);
    }
    for (const [i, linha] of FIXTURE_B.entries()) {
      const id = await criarContato(orgB, `B${i}`, linha.c);
      idsDeB.add(id);
      await criarNegocios(orgB, id, funilB, etapaB, linha.l ?? []);
    }
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await apagarOrgsDoTeste();
    const sobra = await db.from("contacts").select("id", { count: "exact", head: true }).in("organization_id", [orgA, orgB].filter(Boolean));
    if (sobra.error) throw sobra.error;
    expect(sobra.count).toBe(0);
  }, 60_000);

  const nomeDoCaso = (c: Caso) =>
    `${c.op}${c.valor ? ` "${c.valor}"` : ""} · ${c.escopo} · ${c.funil ? "funil 1" : "sem funil"}`;

  it.each(CASOS.map((c) => [nomeDoCaso(c), c] as const))("%s", async (_nome, caso) => {
    const f = filtrosDeContatosSchema.parse({
      campo: CAMPO,
      campo_op: caso.op,
      ...(caso.valor !== undefined ? { campo_valor: caso.valor } : {}),
      campo_escopo: caso.escopo,
      ...(caso.funil ? { funil: funil1 } : {}),
    });
    const ctx = { organizationId: orgA, requestId: "teste-integracao", timezone: "UTC" };
    const { ids } = await idsDoFiltro(db, f, ctx, 5_000);
    const numeroDe = new Map([...idDe].map(([n, id]) => [id, n]));
    for (const id of ids) expect(idsDeB.has(id), "contato da organização B vazou").toBe(false);
    const achados = ids.map((id) => numeroDe.get(id) ?? -1).sort((a, b) => a - b);
    expect(achados).toEqual(caso.esperado);
    // A contagem ("selecionar todos os N") é outra requisição (`head` + `count`) sobre as mesmas junções.
    expect(await contarContatos(db, f, ctx)).toBe(caso.esperado.length);
  });

  it("a organização B, consultada com os mesmos filtros, só devolve os dela", async () => {
    const f = filtrosDeContatosSchema.parse({ campo: CAMPO, campo_op: "contem", campo_valor: "gerente" });
    const { ids } = await idsDoFiltro(db, f, { organizationId: orgB, requestId: "t", timezone: "UTC" }, 5_000);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(idsDeB.has(id)).toBe(true);
  });
});
