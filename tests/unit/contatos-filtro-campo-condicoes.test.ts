/**
 * As condições do filtro por campo personalizado além de "contém" e "é igual a": "não contém",
 * "é diferente de", "é qualquer um de", "está vazio" e "não está vazio".
 *
 * Três camadas: a forma (schema e URL), o que a consulta PEDE ao PostgREST (gravador do builder) e
 * o CONJUNTO que sai, sobre o banco em memória que aplica os filtros de verdade
 * (`helpers/supabase-em-memoria.ts`), com duas organizações. O esperado de cada caso é escrito à
 * mão a partir dos dados, não calculado pelo código sob teste.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/contacts/cpf-do-contato", () => ({ idsPorHashDeCpf: vi.fn(async () => ({ ids: [], error: null })) }));

import { consultaDeContatos, contarContatos, idsDoFiltro } from "@/lib/contacts/consulta";
import { campoDoFiltro, resumoDoFiltroParaAuditoria, temFiltro } from "@/lib/contacts/filtros";
import { filtrosFromParams, filtrosParaCorpo, filtrosToParams, quantidadeDeFiltros } from "@/lib/contacts/filtros-url";
import { filtrosDeContatosSchema, valoresDeQualquerDe } from "@/lib/schemas/contacts";

import { clienteEmMemoria, criarBanco } from "./helpers/supabase-em-memoria";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const F1 = "f1111111-1111-4111-8111-111111111111";
const F2 = "f2222222-2222-4222-8222-222222222222";
const uid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const filtros = (entrada: Record<string, unknown>) => filtrosDeContatosSchema.parse(entrada);
const ctxDe = (organizationId: string) => ({ organizationId, requestId: "r", timezone: "UTC" });

/** Grava cada chamada do builder do PostgREST: é o que a consulta pede ao banco. */
function gravador() {
  const chamadas: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_alvo, metodo: string) => (...args: unknown[]) => {
        chamadas.push([metodo, ...args]);
        return builder;
      },
    },
  );
  const supabase = { from: () => builder };
  return { supabase: supabase as never, chamadas };
}

describe("schema das condições", () => {
  it("'está vazio' e 'não está vazio' valem só com o campo; com valor, recusa", () => {
    for (const op of ["vazio", "preenchido"]) {
      expect(filtrosDeContatosSchema.safeParse({ campo: "cargo", campo_op: op }).success, op).toBe(true);
      expect(filtrosDeContatosSchema.safeParse({ campo: "cargo", campo_op: op, campo_valor: "x" }).success, op).toBe(false);
      expect(filtrosDeContatosSchema.safeParse({ campo_op: op }).success, op).toBe(true); // sem campo = sem filtro
    }
  });

  it("as condições com valor exigem o valor", () => {
    for (const op of ["contem", "nao_contem", "igual", "diferente", "qualquer_de"]) {
      expect(filtrosDeContatosSchema.safeParse({ campo: "cargo", campo_op: op }).success, op).toBe(false);
      expect(filtrosDeContatosSchema.safeParse({ campo: "cargo", campo_op: op, campo_valor: "x" }).success, op).toBe(true);
    }
  });

  it("operador desconhecido é recusado", () => {
    expect(filtrosDeContatosSchema.safeParse({ campo: "cargo", campo_op: "maior", campo_valor: "x" }).success).toBe(false);
  });

  it("'é qualquer um de': vírgula separa, espaços saem, vazios somem, `\\,` é vírgula do valor, até 20", () => {
    expect(valoresDeQualquerDe(" a , b,,  ,c ")).toEqual(["a", "b", "c"]);
    expect(valoresDeQualquerDe("Diretora\\, Vendas, Gerente")).toEqual(["Diretora, Vendas", "Gerente"]);
    const vinte = Array.from({ length: 20 }, (_, i) => `v${i}`).join(",");
    expect(filtrosDeContatosSchema.safeParse({ campo: "cargo", campo_op: "qualquer_de", campo_valor: vinte }).success).toBe(true);
    expect(
      filtrosDeContatosSchema.safeParse({ campo: "cargo", campo_op: "qualquer_de", campo_valor: `${vinte},v20` }).success,
    ).toBe(false);
    expect(filtrosDeContatosSchema.safeParse({ campo: "cargo", campo_op: "qualquer_de", campo_valor: " , ," }).success).toBe(false);
  });

  it("o filtro sem valor conta como filtro ligado (contagem, auditoria e a recusa de campo restrito)", () => {
    const f = filtros({ campo: "cargo", campo_op: "vazio", campo_escopo: "negocio" });
    expect(temFiltro(f)).toBe(true);
    expect(campoDoFiltro(f)).toBe("cargo");
    expect(campoDoFiltro(filtros({}))).toBeNull();
    expect(resumoDoFiltroParaAuditoria(f)).toEqual({ campo: { escopo: "negocio", chave: "cargo", operador: "vazio" } });
    expect(quantidadeDeFiltros({ campo: "cargo", campo_op: "preenchido" })).toBe(1);
  });
});

describe("as condições na URL", () => {
  it("vazio e preenchido vão e voltam sem valor; valor que sobrou na URL é descartado", () => {
    for (const op of ["vazio", "preenchido"] as const) {
      const f = filtrosFromParams(new URLSearchParams(`campo=cargo&campo_op=${op}&campo_escopo=contato`));
      expect(f).toEqual({ campo: "cargo", campo_op: op, campo_escopo: "contato" });
      expect(filtrosFromParams(filtrosToParams(f))).toEqual(f);
      expect(filtrosDeContatosSchema.safeParse(filtrosParaCorpo(f)).success).toBe(true);
      expect(filtrosFromParams(new URLSearchParams(`campo=cargo&campo_op=${op}&campo_valor=x`))).not.toHaveProperty(
        "campo_valor",
      );
    }
  });

  it("não contém, diferente e qualquer um de vão e voltam com o valor", () => {
    for (const op of ["nao_contem", "diferente", "qualquer_de"] as const) {
      const f = filtrosFromParams(new URLSearchParams({ campo: "cargo", campo_op: op, campo_valor: 'a\\, "b", c' }));
      expect(f).toMatchObject({ campo: "cargo", campo_op: op, campo_valor: 'a\\, "b", c' });
      expect(filtrosFromParams(filtrosToParams(f))).toEqual(f);
      expect(filtrosDeContatosSchema.safeParse(filtrosParaCorpo(f)).success).toBe(true);
    }
  });

  it("operador desconhecido na URL vira 'contém'; condição com valor sem valor some", () => {
    expect(filtrosFromParams(new URLSearchParams("campo=cargo&campo_op=xx&campo_valor=a")).campo_op).toBe("contem");
    expect(filtrosFromParams(new URLSearchParams("campo=cargo&campo_op=diferente"))).toEqual({});
    const demais = Array.from({ length: 21 }, (_, i) => `v${i}`).join(",");
    expect(filtrosFromParams(new URLSearchParams({ campo: "cargo", campo_op: "qualquer_de", campo_valor: demais }))).toEqual({});
    expect(filtrosFromParams(new URLSearchParams("campo=cpf&campo_op=vazio"))).toEqual({});
  });
});

describe("o que a consulta pede ao PostgREST", () => {
  const pedir = async (entrada: Record<string, unknown>) => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros(entrada), ctxDe(ORG_A));
    return { chamadas, select: chamadas.find((c) => c[0] === "select")![1] as string };
  };
  const LF = "lf:crm_leads!crm_leads_contact_id_fkey!inner(id)";
  const LC = "lc:crm_leads!crm_leads_contact_id_fkey(id)";

  it("contato: vazio = NULL ou sem caractere visível; preenchido = `match \\S`; sem junção", async () => {
    const vazio = await pedir({ campo_escopo: "contato", campo: "cargo", campo_op: "vazio" });
    expect(vazio.select).toBe("id");
    expect(vazio.chamadas).toContainEqual(["or", 'custom_fields->>cargo.is.null,custom_fields->>cargo.not.match."\\\\S"']);
    const cheio = await pedir({ campo_escopo: "contato", campo: "cargo", campo_op: "preenchido" });
    expect(cheio.chamadas).toContainEqual(["regexMatch", "custom_fields->>cargo", "\\S"]);
  });

  it("contato: não contém e diferente são a negação com o NULL incluído", async () => {
    const nc = await pedir({ campo_escopo: "contato", campo: "cargo", campo_op: "nao_contem", campo_valor: "dir" });
    expect(nc.chamadas).toContainEqual(["or", 'custom_fields->>cargo.is.null,custom_fields->>cargo.not.ilike."%dir%"']);
    const dif = await pedir({ campo_escopo: "contato", campo: "cargo", campo_op: "diferente", campo_valor: "dir" });
    expect(dif.chamadas).toContainEqual(["or", 'custom_fields->>cargo.is.null,custom_fields->>cargo.not.ilike."dir"']);
  });

  it("qualquer um de: UMA regex sem caixa, ancorada, com os metacaracteres escapados", async () => {
    const q = await pedir({ campo_escopo: "contato", campo: "cargo", campo_op: "qualquer_de", campo_valor: "a.b, (c)|d" });
    expect(q.chamadas).toContainEqual(["regexIMatch", "custom_fields->>cargo", "^(a\\.b|\\(c\\)\\|d)$"]);
  });

  it("negócio, positiva: só `lf` (inner) com organização e a condição no MESMO negócio", async () => {
    const p = await pedir({ funil: F1, campo_escopo: "negocio", campo: "cargo", campo_op: "preenchido" });
    expect(p.select).toBe(`id, ${LF}`);
    expect(p.chamadas).toContainEqual(["eq", "lf.organization_id", ORG_A]);
    expect(p.chamadas).toContainEqual(["eq", "lf.pipeline_id", F1]);
    expect(p.chamadas).toContainEqual(["regexMatch", "lf.custom_fields->>cargo", "\\S"]);
  });

  it("negócio, negativa: `lf` prova o negócio no recorte, `lc` filtrado pela positiva + `lc is null`", async () => {
    for (const [op, valor, chamada] of [
      ["vazio", undefined, ["regexMatch", "lc.custom_fields->>cargo", "\\S"]],
      ["nao_contem", "dir", ["ilike", "lc.custom_fields->>cargo", "%dir%"]],
      ["diferente", "dir", ["ilike", "lc.custom_fields->>cargo", "dir"]],
    ] as const) {
      const n = await pedir({ funil: F1, campo_escopo: "negocio", campo: "cargo", campo_op: op, campo_valor: valor });
      expect(n.select, op).toBe(`id, ${LF}, ${LC}`);
      expect(n.chamadas).toContainEqual(["eq", "lf.organization_id", ORG_A]);
      expect(n.chamadas).toContainEqual(["eq", "lc.organization_id", ORG_A]);
      expect(n.chamadas).toContainEqual(["eq", "lc.pipeline_id", F1]);
      expect(n.chamadas).toContainEqual(chamada);
      expect(n.chamadas).toContainEqual(["is", "lc", null]);
      // A condição não vai em `lf`: ele só diz "tem negócio no recorte".
      expect(n.chamadas.some((c) => String(c[1]).startsWith("lf.custom_fields"))).toBe(false);
    }
  });

  it("os dois, positiva: OU entre o contato e `lc`", async () => {
    const p = await pedir({ campo: "cargo", campo_op: "preenchido" });
    expect(p.select).toBe(`id, ${LC}`);
    expect(p.chamadas).toContainEqual(["eq", "lc.organization_id", ORG_A]);
    expect(p.chamadas).toContainEqual(["or", 'custom_fields->>cargo.match."\\\\S",lc.not.is.null']);
  });

  it("os dois, negativa: negativa no contato E `lc is null`", async () => {
    const n = await pedir({ campo: "cargo", campo_op: "vazio" });
    expect(n.select).toBe(`id, ${LC}`);
    expect(n.chamadas).toContainEqual(["eq", "lc.organization_id", ORG_A]);
    expect(n.chamadas).toContainEqual(["regexMatch", "lc.custom_fields->>cargo", "\\S"]);
    expect(n.chamadas).toContainEqual(["or", 'custom_fields->>cargo.is.null,custom_fields->>cargo.not.match."\\\\S"']);
    expect(n.chamadas).toContainEqual(["is", "lc", null]);
  });

  it("qualquer um de no `or`: aspas e vírgulas do valor ficam DENTRO da condição", async () => {
    const p = await pedir({ campo: "cargo", campo_op: "qualquer_de", campo_valor: 'x",lc.not.is.null, y)' });
    const ou = p.chamadas.find((c) => c[0] === "or")![1] as string;
    expect(ou).toBe('custom_fields->>cargo.imatch."^(x\\"|lc\\\\.not\\\\.is\\\\.null|y\\\\))$",lc.not.is.null');
  });

  it("a chave do campo é revalidada também sem valor", async () => {
    const { supabase } = gravador();
    const ruim = { ...filtros({}), campo: "a->b", campo_op: "vazio" as const };
    await expect(consultaDeContatos(supabase, "id", ruim, ctxDe(ORG_A))).rejects.toMatchObject({ status: 422 });
    const sensivel = { ...filtros({}), campo: "cpf", campo_op: "preenchido" as const };
    await expect(consultaDeContatos(supabase, "id", sensivel, ctxDe(ORG_A))).rejects.toMatchObject({ status: 422 });
  });
});

describe("o conjunto que sai (banco em memória, duas organizações)", () => {
  type Linha = Record<string, unknown>;
  const contato = (n: number, custom_fields: Linha, organization_id = ORG_A): Linha => ({
    id: uid(n),
    organization_id,
    display_name: `Contato ${n}`,
    tags: [],
    source: "manual",
    is_merged_into: null,
    is_anonymized: false,
    kind: "person",
    is_personal: false,
    is_blocked: false,
    created_at: "2026-10-10T12:00:00Z",
    last_activity_at: "2026-10-10T12:00:00Z",
    custom_fields,
  });
  const negocio = (id: string, n: number, pipeline_id: string, custom_fields: Linha, organization_id = ORG_A): Linha => ({
    id,
    organization_id,
    contact_id: uid(n),
    pipeline_id,
    stage_id: "e1",
    custom_fields,
  });
  const banco = () =>
    criarBanco({
      contacts: [
        contato(1, { cargo: "Diretora" }), // sem negócio
        contato(2, { cargo: "   " }), // só espaços = vazio; sem negócio
        contato(3, {}), // negócio F1 com Gerente
        contato(4, { cargo: null }), // negócio F1 vazio + negócio F2 "Diretora, Vendas"
        contato(5, { cargo: "diretora" }), // negócio F1 com ""
        contato(6, {}), // só negócio de OUTRA organização (com valor) — não pode contar
        contato(100, { cargo: "Diretora" }, ORG_B),
      ],
      crm_leads: [
        negocio("l1", 3, F1, { cargo: "Gerente" }),
        negocio("l2", 4, F1, {}),
        negocio("l3", 4, F2, { cargo: "Diretora, Vendas" }),
        negocio("l4", 5, F1, { cargo: "" }),
        negocio("l5", 6, F1, { cargo: "Diretora" }, ORG_B),
        negocio("l6", 100, F1, { cargo: "Gerente" }, ORG_B),
      ],
    });

  const casos: Array<{ nome: string; filtro: Record<string, unknown>; esperado: number[]; org?: string }> = [
    // escopo contato
    { nome: "contato vazio", filtro: { campo_escopo: "contato", campo: "cargo", campo_op: "vazio" }, esperado: [2, 3, 4, 6] },
    { nome: "contato preenchido", filtro: { campo_escopo: "contato", campo: "cargo", campo_op: "preenchido" }, esperado: [1, 5] },
    { nome: "contato não contém dir", filtro: { campo_escopo: "contato", campo: "cargo", campo_op: "nao_contem", campo_valor: "dir" }, esperado: [2, 3, 4, 6] },
    { nome: "contato diferente de diretora", filtro: { campo_escopo: "contato", campo: "cargo", campo_op: "diferente", campo_valor: "DIRETORA" }, esperado: [2, 3, 4, 6] },
    { nome: "contato um de (sem caixa)", filtro: { campo_escopo: "contato", campo: "cargo", campo_op: "qualquer_de", campo_valor: "Gerente, diretora" }, esperado: [1, 5] },
    { nome: "contato um de: o ponto é literal", filtro: { campo_escopo: "contato", campo: "cargo", campo_op: "qualquer_de", campo_valor: "Diretor." }, esperado: [] },
    // escopo negócio
    { nome: "negócio preenchido", filtro: { campo_escopo: "negocio", campo: "cargo", campo_op: "preenchido" }, esperado: [3, 4] },
    { nome: "negócio vazio: tem negócio e nenhum com valor", filtro: { campo_escopo: "negocio", campo: "cargo", campo_op: "vazio" }, esperado: [5] },
    { nome: "negócio não contém dir", filtro: { campo_escopo: "negocio", campo: "cargo", campo_op: "nao_contem", campo_valor: "dir" }, esperado: [3, 5] },
    { nome: "negócio diferente de gerente", filtro: { campo_escopo: "negocio", campo: "cargo", campo_op: "diferente", campo_valor: "gerente" }, esperado: [4, 5] },
    { nome: "negócio um de", filtro: { campo_escopo: "negocio", campo: "cargo", campo_op: "qualquer_de", campo_valor: "gerente, diretora" }, esperado: [3] },
    { nome: "negócio um de, com vírgula escapada", filtro: { campo_escopo: "negocio", campo: "cargo", campo_op: "qualquer_de", campo_valor: "diretora\\, vendas" }, esperado: [4] },
    { nome: "negócio preenchido no funil F1", filtro: { funil: F1, campo_escopo: "negocio", campo: "cargo", campo_op: "preenchido" }, esperado: [3] },
    { nome: "negócio vazio no funil F1", filtro: { funil: F1, campo_escopo: "negocio", campo: "cargo", campo_op: "vazio" }, esperado: [4, 5] },
    // escopo "os dois"
    { nome: "os dois preenchido", filtro: { campo: "cargo", campo_op: "preenchido" }, esperado: [1, 3, 4, 5] },
    { nome: "os dois vazio (sem negócio e vazio no contato conta)", filtro: { campo: "cargo", campo_op: "vazio" }, esperado: [2, 6] },
    { nome: "os dois não contém dir", filtro: { campo: "cargo", campo_op: "nao_contem", campo_valor: "dir" }, esperado: [2, 3, 6] },
    { nome: "os dois diferente de gerente", filtro: { campo: "cargo", campo_op: "diferente", campo_valor: "gerente" }, esperado: [1, 2, 4, 5, 6] },
    { nome: "os dois um de", filtro: { campo: "cargo", campo_op: "qualquer_de", campo_valor: "Gerente,diretora" }, esperado: [1, 3, 5] },
    { nome: "os dois vazio + funil F1", filtro: { funil: F1, campo: "cargo", campo_op: "vazio" }, esperado: [4] },
    { nome: "os dois preenchido + funil F1", filtro: { funil: F1, campo: "cargo", campo_op: "preenchido" }, esperado: [3, 5] },
    // injeção pelo `or`: o valor não abre outra condição
    { nome: "um de com aspas e vírgula não injeta `lc.not.is.null`", filtro: { campo: "cargo", campo_op: "qualquer_de", campo_valor: '",lc.not.is.null' }, esperado: [] },
    // a outra organização vê só o que é dela
    { nome: "org B: os dois preenchido", filtro: { campo: "cargo", campo_op: "preenchido" }, esperado: [100], org: ORG_B },
    { nome: "org B: negócio vazio", filtro: { campo_escopo: "negocio", campo: "cargo", campo_op: "vazio" }, esperado: [], org: ORG_B },
  ];

  for (const caso of casos) {
    it(caso.nome, async () => {
      const esperado = caso.esperado.map(uid).sort();
      const f = filtros(caso.filtro);
      const cliente = clienteEmMemoria(banco());
      const ctx = ctxDe(caso.org ?? ORG_A);
      expect((await idsDoFiltro(cliente, f, ctx, 5000)).ids.sort()).toEqual(esperado);
      expect(await contarContatos(cliente, f, ctx)).toBe(esperado.length);
    });
  }
});
