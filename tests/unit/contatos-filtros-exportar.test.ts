import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/contacts/cpf-do-contato", () => ({ idsPorHashDeCpf: vi.fn(async () => ({ ids: [], error: null })) }));

import { consultaDeContatos, semJuncoes } from "@/lib/contacts/consulta";
import { BOM, celulaCsv, montarCsvDeContatos, telefoneParaPlanilha } from "@/lib/contacts/exportar-csv";
import {
  inicioDoDiaNoFuso,
  intervaloEmInstantes,
  periodoDoFiltro,
  resumoDoFiltroParaAuditoria,
} from "@/lib/contacts/filtros";
import { etapasDoFiltro, filtrosFromParams, filtrosParaCorpo, filtrosToParams } from "@/lib/contacts/filtros-url";
import { contactListQuerySchema, filtrosDeContatosSchema } from "@/lib/schemas";

const ORG = "11111111-1111-4111-8111-111111111111";
const FUNIL = "22222222-2222-4222-8222-222222222222";
const ETAPA = "33333333-3333-4333-8333-333333333333";

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
  const supabase = {
    from: (tabela: string) => {
      chamadas.push(["from", tabela]);
      return builder;
    },
  };
  return { supabase: supabase as never, chamadas };
}

const filtros = (entrada: Record<string, unknown>) => filtrosDeContatosSchema.parse(entrada);
const ctx = { organizationId: ORG, requestId: "r1", timezone: "America/Sao_Paulo", agora: new Date("2026-10-19T01:30:00Z") };

describe("período no fuso da organização", () => {
  it("o dia começa à meia-noite DO FUSO, não do UTC", () => {
    expect(inicioDoDiaNoFuso("2026-10-19", "America/Sao_Paulo")).toBe("2026-10-19T03:00:00.000Z");
    expect(inicioDoDiaNoFuso("2026-10-19", "UTC")).toBe("2026-10-19T00:00:00.000Z");
    expect(inicioDoDiaNoFuso("2026-10-19", null)).toBe("2026-10-19T00:00:00.000Z");
    expect(inicioDoDiaNoFuso("2026-10-19", "Fuso/Que/Nao/Existe")).toBe("2026-10-19T00:00:00.000Z");
  });

  it("'Hoje' às 22h30 em São Paulo (01:30 UTC do dia seguinte) ainda é o dia de São Paulo", () => {
    const agora = new Date("2026-10-19T01:30:00Z"); // 18/10 22:30 em São Paulo
    const i = intervaloEmInstantes({ predefinido: "hoje" }, agora, "America/Sao_Paulo");
    expect(i).toEqual({ gte: "2026-10-18T03:00:00.000Z", lt: "2026-10-19T03:00:00.000Z" });
  });

  it("de/até personalizado é fechado nas duas pontas (até inclui o dia inteiro)", () => {
    const i = intervaloEmInstantes({ de: "2026-10-01", ate: "2026-10-15" }, new Date(), "America/Sao_Paulo");
    expect(i).toEqual({ gte: "2026-10-01T03:00:00.000Z", lt: "2026-10-16T03:00:00.000Z" });
  });

  it("'de' depois de 'até' é troca de campos, não filtro vazio", () => {
    const i = intervaloEmInstantes({ de: "2026-10-15", ate: "2026-10-01" }, new Date(), "UTC");
    expect(i?.gte).toBe("2026-10-01T00:00:00.000Z");
  });

  it("sem período, sem filtro", () => {
    expect(periodoDoFiltro(filtros({}), "criado")).toBeUndefined();
    expect(intervaloEmInstantes(undefined, new Date(), "UTC")).toBeNull();
  });
});

describe("esquema dos filtros", () => {
  it("recusa chave de campo que não seja identificador simples (vira caminho JSON)", () => {
    for (const campo of ["a->b", "x'; drop table contacts;--", "a b", "1abc", "a.b", "a,b", "", "cpf", "CPF_titular", "rg", "numero_rg", "documento", "cnpj", "cpf_cnpj", "passaporte"]) {
      expect(filtrosDeContatosSchema.safeParse({ campo, campo_valor: "x" }).success, campo).toBe(false);
    }
    expect(filtrosDeContatosSchema.safeParse({ campo: "utm_source", campo_valor: "google" }).success).toBe(true);
    // "cargo" contém "rg" mas não é RG
    expect(filtrosDeContatosSchema.safeParse({ campo: "cargo", campo_valor: "x" }).success).toBe(true);
  });

  it("campo e valor andam juntos", () => {
    expect(filtrosDeContatosSchema.safeParse({ campo: "cargo" }).success).toBe(false);
    expect(filtrosDeContatosSchema.safeParse({ campo_valor: "x" }).success).toBe(false);
    expect(contactListQuerySchema.safeParse({ campo: "cargo" }).success).toBe(false);
  });

  it("data absurda não chega ao banco: fora de 2000-01-01..2100-12-31 é 422, não 500", () => {
    for (const d of ["9999-12-31", "1999-12-31", "2101-01-01", "0000-01-01"]) {
      expect(filtrosDeContatosSchema.safeParse({ criado_ate: d }).success, d).toBe(false);
      expect(filtrosDeContatosSchema.safeParse({ ativ_de: d }).success, d).toBe(false);
    }
    expect(filtrosDeContatosSchema.safeParse({ criado_de: "2000-01-01", criado_ate: "2100-12-31" }).success).toBe(true);
  });

  it("recusa data malformada, atalho desconhecido e funil que não é uuid", () => {
    expect(filtrosDeContatosSchema.safeParse({ criado_de: "19/10/2026" }).success).toBe(false);
    expect(filtrosDeContatosSchema.safeParse({ ativ: "ontem" }).success).toBe(false);
    expect(filtrosDeContatosSchema.safeParse({ funil: "abc" }).success).toBe(false);
  });

  it("a lista continua aceitando os parâmetros de antes", () => {
    const q = contactListQuerySchema.parse({ search: "ana", tag: "VIP", source: "site", limit: "25" });
    expect(q).toMatchObject({ search: "ana", tag: "vip", source: "site", limit: 25, order_by: "last_activity_at" });
  });
});

describe("consulta de contatos (o que vai ao banco)", () => {
  it("sempre filtra a organização e ignora a lápide de fusão", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros({}), ctx);
    expect(chamadas).toContainEqual(["eq", "organization_id", ORG]);
    expect(chamadas).toContainEqual(["is", "is_merged_into", null]);
  });

  it("período vira intervalo de instantes em created_at e last_activity_at", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros({ criado: "hoje", ativ_de: "2026-10-01", ativ_ate: "2026-10-02" }), ctx);
    expect(chamadas).toContainEqual(["gte", "created_at", "2026-10-18T03:00:00.000Z"]);
    expect(chamadas).toContainEqual(["lt", "created_at", "2026-10-19T03:00:00.000Z"]);
    expect(chamadas).toContainEqual(["gte", "last_activity_at", "2026-10-01T03:00:00.000Z"]);
    expect(chamadas).toContainEqual(["lt", "last_activity_at", "2026-10-03T03:00:00.000Z"]);
  });

  it("funil e etapa entram por junção com a organização conferida, sem lista de ids", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id, name", filtros({ funil: FUNIL, etapa: ETAPA }), ctx);
    const select = chamadas.find((c) => c[0] === "select")!;
    expect(select[1]).toBe("id, name, lf:crm_leads!crm_leads_contact_id_fkey!inner(id)");
    expect(chamadas).toContainEqual(["eq", "lf.organization_id", ORG]);
    expect(chamadas).toContainEqual(["eq", "lf.pipeline_id", FUNIL]);
    expect(chamadas).toContainEqual(["in", "lf.stage_id", [ETAPA]]);
    // Nenhuma lista de ids de CONTATO: só as etapas escolhidas vão no `in`.
    expect(chamadas.filter((c) => c[0] === "in").map((c) => c[1])).toEqual(["lf.stage_id"]);
  });

  it("várias etapas: um `in` na junção, na ordem pedida; a forma antiga (um id) continua valendo", async () => {
    const OUTRA = "44444444-4444-4444-8444-444444444444";
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros({ funil: FUNIL, etapa: `${ETAPA},${OUTRA}` }), ctx);
    expect(chamadas).toContainEqual(["in", "lf.stage_id", [ETAPA, OUTRA]]);
    expect(filtros({ etapa: ETAPA }).etapa).toEqual([ETAPA]);
    expect(filtros({ etapa: [ETAPA, OUTRA] }).etapa).toEqual([ETAPA, OUTRA]);
    expect(filtrosDeContatosSchema.safeParse({ etapa: `${ETAPA},abc` }).success).toBe(false);
    const demais = Array.from({ length: 101 }, () => ETAPA).join(",");
    expect(filtrosDeContatosSchema.safeParse({ etapa: demais }).success).toBe(false);
  });

  it("campo em qualquer lugar (padrão): OU entre o contato e uma junção OPCIONAL de negócios", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros({ campo: "utm_source", campo_op: "igual", campo_valor: "lead_ads" }), ctx);
    const select = chamadas.find((c) => c[0] === "select")![1] as string;
    // Sem `!inner`: quem tem o valor só no próprio cadastro não pode ser cortado pela junção.
    expect(select).toBe("id, lc:crm_leads!crm_leads_contact_id_fkey(id)");
    expect(chamadas).toContainEqual(["eq", "lc.organization_id", ORG]);
    expect(chamadas).toContainEqual(["ilike", "lc.custom_fields->>utm_source", "lead\\_ads"]);
    expect(chamadas).toContainEqual(["or", 'custom_fields->>utm_source.ilike."lead\\\\_ads",lc.not.is.null']);
  });

  it("campo em qualquer lugar + funil e etapas: a junção opcional leva os mesmos predicados", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(
      supabase,
      "id",
      filtros({ funil: FUNIL, etapa: ETAPA, campo: "utm_source", campo_valor: "google" }),
      ctx,
    );
    const select = chamadas.find((c) => c[0] === "select")![1] as string;
    expect(select).toBe(
      "id, lf:crm_leads!crm_leads_contact_id_fkey!inner(id), lc:crm_leads!crm_leads_contact_id_fkey(id)",
    );
    expect(chamadas).toContainEqual(["eq", "lc.pipeline_id", FUNIL]);
    expect(chamadas).toContainEqual(["in", "lc.stage_id", [ETAPA]]);
    expect(chamadas).toContainEqual(["eq", "lf.pipeline_id", FUNIL]);
  });

  it("o valor do campo vai ENTRE ASPAS no `or`: vírgula e parêntese não abrem outra condição", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros({ campo: "cargo", campo_valor: 'a,b) "x"' }), ctx);
    const ou = chamadas.find((c) => c[0] === "or")![1] as string;
    expect(ou).toBe('custom_fields->>cargo.ilike."%a,b) \\"x\\"%",lc.not.is.null');
  });

  it("campo do contato: ilike no caminho JSON, com curingas do valor escapados", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros({ campo_escopo: "contato", campo: "cargo", campo_valor: "100%_ok\\" }), ctx);
    expect(chamadas).toContainEqual(["ilike", "custom_fields->>cargo", "%100\\%\\_ok\\\\%"]);
  });

  it("campo 'igual' não leva curinga nas pontas", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros({ campo_escopo: "contato", campo: "empresa", campo_op: "igual", campo_valor: "Acme" }), ctx);
    expect(chamadas).toContainEqual(["ilike", "custom_fields->>empresa", "Acme"]);
  });

  it("campo do negócio + funil: UMA junção só (os predicados valem no MESMO negócio)", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(
      supabase,
      "id",
      filtros({ funil: FUNIL, campo_escopo: "negocio", campo: "utm_source", campo_valor: "google" }),
      ctx,
    );
    const select = chamadas.find((c) => c[0] === "select")![1] as string;
    expect(select).toBe("id, lf:crm_leads!crm_leads_contact_id_fkey!inner(id)");
    expect(chamadas).toContainEqual(["eq", "lf.organization_id", ORG]);
    expect(chamadas).toContainEqual(["eq", "lf.pipeline_id", FUNIL]);
    expect(chamadas).toContainEqual(["ilike", "lf.custom_fields->>utm_source", "%google%"]);
  });

  it("`*` do valor vira texto (no PostgREST ele é curinga e não tem escape)", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros({ campo_escopo: "contato", campo: "cargo", campo_valor: "a*b" }), ctx);
    expect(chamadas).toContainEqual(["ilike", "custom_fields->>cargo", "%a_b%"]);
    const busca = gravador();
    await consultaDeContatos(busca.supabase, "id", filtros({ search: "a*b" }), ctx);
    const ou = busca.chamadas.find((c) => c[0] === "or")![1] as string;
    expect(ou).toContain("name.ilike.%a_b%");
    expect(ou).not.toContain("*");
  });

  it("só o que o lote opera: somenteOperaveis tira o anonimizado", async () => {
    const { supabase, chamadas } = gravador();
    await consultaDeContatos(supabase, "id", filtros({}), { ...ctx, somenteOperaveis: true });
    expect(chamadas).toContainEqual(["eq", "is_anonymized", false]);
    const lista = gravador();
    await consultaDeContatos(lista.supabase, "id", filtros({}), ctx);
    expect(lista.chamadas).not.toContainEqual(["eq", "is_anonymized", false]);
  });

  it("recusa chave de campo inválida mesmo vinda de objeto montado em código", async () => {
    const { supabase } = gravador();
    const ruim = { ...filtros({}), campo: "a->b", campo_valor: "x" };
    await expect(consultaDeContatos(supabase, "id", ruim, ctx)).rejects.toMatchObject({ status: 422 });
  });

  it("as junções saem da linha antes da resposta", () => {
    expect(semJuncoes({ id: "1", lf: [{ id: "x" }], lc: [], name: "A" })).toEqual({ id: "1", name: "A" });
  });
});

describe("auditoria do filtro", () => {
  it("não leva o texto buscado nem o valor do campo", () => {
    const resumo = resumoDoFiltroParaAuditoria(
      filtros({ search: "Maria Silva 11999990000", campo: "cargo", campo_valor: "diretora", funil: FUNIL }),
    );
    const texto = JSON.stringify(resumo);
    expect(texto).not.toContain("Maria");
    expect(texto).not.toContain("11999990000");
    expect(texto).not.toContain("diretora");
    expect(resumo).toMatchObject({ busca: true, funil_id: FUNIL, campo: { escopo: "qualquer", chave: "cargo", operador: "contem" } });
  });
});

describe("filtros na URL", () => {
  it("vai e volta, e descarta o que a tela não produz", () => {
    const f = filtrosFromParams(
      new URLSearchParams(`search=ana&criado=7d&ativ_de=2026-10-01&funil=${FUNIL}&campo=utm_source&campo_valor=google&campo_escopo=negocio`),
    );
    expect(f).toMatchObject({ search: "ana", criado: "7d", ativ_de: "2026-10-01", funil: FUNIL, campo_escopo: "negocio", campo_op: "contem" });
    expect(filtrosFromParams(filtrosToParams(f))).toEqual(f);
    expect(filtrosParaCorpo(f)).toMatchObject({ search: "ana", funil: FUNIL });
  });

  it("URL editada à mão não vira 422: valores inválidos somem", () => {
    const f = filtrosFromParams(new URLSearchParams("funil=abc&criado=ontem&criado_de=hoje&ativ_ate=9999-12-31&campo=a-b&campo_valor=x"));
    expect(f).toEqual({});
  });

  it("várias etapas na URL: separadas por vírgula; id inválido sai sozinho, o resto fica", () => {
    const OUTRA = "44444444-4444-4444-8444-444444444444";
    const f = filtrosFromParams(new URLSearchParams(`funil=${FUNIL}&etapa=${ETAPA},abc,${OUTRA},${ETAPA}`));
    expect(f.etapa).toBe(`${ETAPA},${OUTRA}`);
    expect(etapasDoFiltro(f)).toEqual([ETAPA, OUTRA]);
    expect(filtrosFromParams(filtrosToParams(f))).toEqual(f);
    expect(filtrosDeContatosSchema.parse(filtrosParaCorpo(f)).etapa).toEqual([ETAPA, OUTRA]);
    expect(filtrosFromParams(new URLSearchParams("etapa=abc"))).toEqual({});
  });

  it("campo sem escopo na URL é 'qualquer' (contato ou negócio); os escopos antigos continuam", () => {
    const base = "campo=utm_source&campo_valor=lead_ads";
    expect(filtrosFromParams(new URLSearchParams(base)).campo_escopo).toBe("qualquer");
    expect(filtrosFromParams(new URLSearchParams(`${base}&campo_escopo=contato`)).campo_escopo).toBe("contato");
    expect(filtrosFromParams(new URLSearchParams(`${base}&campo_escopo=negocio`)).campo_escopo).toBe("negocio");
    expect(filtrosDeContatosSchema.parse({ campo: "utm_source", campo_valor: "x" }).campo_escopo).toBe("qualquer");
  });

  it("campo de documento na URL é descartado", () => {
    expect(filtrosFromParams(new URLSearchParams("campo=cpf&campo_valor=1"))).toEqual({});
  });

  it("atalho tem precedência sobre de/até (a URL guarda um dos dois)", () => {
    expect(filtrosFromParams(new URLSearchParams("criado=30d&criado_de=2026-01-01"))).toEqual({ criado: "30d" });
  });
});

describe("CSV de contatos", () => {
  const ref = {
    timezone: "America/Sao_Paulo",
    funis: new Map([["f1", "Vendas"]]),
    etapas: new Map([["e1", "Proposta"]]),
    rotulosDeCampo: new Map([["cargo", "Cargo"]]),
  };
  const contato = {
    display_name: "Ana Souza",
    email: "ana@exemplo.com",
    phone_number: "+5535999990001",
    tags: ["vip", "lead"],
    source: "meta_ads",
    created_at: "2026-10-19T01:30:00Z",
    last_activity_at: null,
    custom_fields: { cargo: "Diretora", cpf: "123.456.789-09", CPF_titular: "x", utm_source: "google", rg: "1", numero_rg: "2", Documento: "3", cnpj: "4", cpf_cnpj: "5", passaporte: "6" },
    leads: [{ pipeline_id: "f1", stage_id: "e1" }],
  };

  it("UTF-8 com BOM, vírgula, CRLF, colunas pedidas e datas no fuso da organização", () => {
    const csv = montarCsvDeContatos([contato], ref);
    expect(csv.startsWith(BOM)).toBe(true);
    const [cab, linha] = csv.slice(1).split("\r\n");
    expect(cab).toBe("Nome,E-mail,Telefone,Tags,Origem,Entrou no CRM,Última atividade,Funis e etapas,Cargo,utm_source");
    expect(linha).toBe("Ana Souza,ana@exemplo.com,+55 35 99999-0001,vip; lead,Anúncio da Meta,18/10/2026 22:30,,Vendas > Proposta,Diretora,google");
  });

  it("nunca leva CPF nem documento (rg, cnpj, passaporte...), nem como campo personalizado", () => {
    const csv = montarCsvDeContatos([contato], ref);
    expect(csv).not.toMatch(/cpf|cnpj|passaporte|documento|\brg\b|numero_rg/i);
    expect(csv).not.toContain("123.456.789-09");
  });

  it("neutraliza fórmula de planilha, mas não estraga telefone nem número", () => {
    expect(celulaCsv('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(celulaCsv("@cmd")).toBe("'@cmd");
    expect(celulaCsv("+cmd|' /C calc'!A0")).toBe(`'+cmd|' /C calc'!A0`);
    expect(celulaCsv("+55 35 99999-0001")).toBe("+55 35 99999-0001");
    expect(celulaCsv("-12,5")).toBe('"-12,5"');
  });

  it("vírgula, aspas e quebra de linha ficam entre aspas", () => {
    expect(celulaCsv('Silva, "Maria"\nX')).toBe('"Silva, ""Maria""\nX"');
  });

  it("telefone brasileiro vira texto legível; estrangeiro fica como está", () => {
    expect(telefoneParaPlanilha("+5535999990001")).toBe("+55 35 99999-0001");
    expect(telefoneParaPlanilha(null)).toBe("");
  });

  it("limita as colunas de campo personalizado", () => {
    const muitos = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`campo${i}`, "v"]));
    const cab = montarCsvDeContatos([{ ...contato, custom_fields: muitos }], ref).split("\r\n")[0]!;
    expect(cab.split(",").length).toBe(8 + 40);
  });
});
