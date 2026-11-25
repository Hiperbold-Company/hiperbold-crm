import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O AGENTE GRAVA CAMPO PERSONALIZADO NO ESCOPO DA DEFINIÇÃO (`crm_set_custom_field`).
 *
 * A cadeia de verdade: a ferramenta montada como o turno monta
 * (`pickToolsFromMcp`) e o `patchContactHandler` real, sobre um banco falso
 * que APLICA os filtros (`eq`) e guarda o UPDATE. Dublês só nas bordas: o
 * gravador da auditoria (`@/lib/audit`, para conferir o que foi gravado), a
 * consulta de CPF, que usa o cliente de serviço, e — no campo do NEGÓCIO — a
 * escrita do negócio (`crmUpdateLead.handler`), que usa o cliente de serviço
 * por dentro e tem a própria suíte. Aqui se prova o ROTEAMENTO: qual negócio,
 * quais chaves, o escopo de funil e a ausência de gravação em dobro.
 *
 * ─── SABOTAGEM (o que deixa este arquivo vermelho) ─────────────────────────
 * - Mesclar trocado por substituir (`{ ...validos }` no PATCH): "preserva as
 *   outras chaves" cai.
 * - Gravar o campo do negócio no contato: "vai para o negócio aberto" cai.
 * - Escolher o primeiro negócio quando há dois abertos: "ambíguo" cai.
 * - Tirar o `podeOperarNoFunil`: "funil fora do escopo" cai.
 * - Ler o contato do argumento em vez de `ctx.contatoDoTurno`: sem contato do
 *   turno a ferramenta grava em vez de recusar.
 * - Tirar o `.eq("organization_id", …)` da leitura da ficha: o contato de outra
 *   organização é achado e gravado.
 * - Tirar a linha de `TOOLS_ATENDIMENTO`/`allTools`: a ferramenta não monta.
 */

const auditados: Array<Record<string, unknown>> = [];
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async (e: Record<string, unknown>) => void auditados.push(e)) }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/contacts/cpf-do-contato", async (original) => ({
  ...(await original<typeof import("@/lib/contacts/cpf-do-contato")>()),
  idsComCpf: async () => ({ ids: new Set<string>(), error: null }),
  idsPorHashDeCpf: async () => ({ ids: [], error: null }),
}));

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { crmSetCustomField } = await import("@/lib/mcp/tools/campo-personalizado");
const { crmUpdateLead } = await import("@/lib/mcp/tools/leads");
const { catalogEntry } = await import("@/lib/mcp/tools/catalog");
const { MODULOS_OPCIONAIS } = await import("@/lib/instalacao/modulos");
const { CAPACIDADES_DA_ORGANIZACAO } = await import("@/lib/organizacao/capacidades");
const {
  converterValorDoCampo,
  descricaoComOsCampos,
  camposGravaveisPeloAgente,
} = await import("@/lib/campos/campo-pelo-agente");

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_B = "55555555-5555-4555-8555-555555555555";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONTATO_B = "66666666-6666-4666-8666-666666666666";
const NOME = "crm_set_custom_field";
const NEGOCIO = "33333333-3333-4333-8333-333333333333";
const NEGOCIO_2 = "44444444-4444-4444-8444-444444444444";
const FUNIL = "77777777-7777-4777-8777-777777777777";
const OUTRO_FUNIL = "88888888-8888-4888-8888-888888888888";

type Linha = Record<string, unknown>;

const DEFINICOES = (org: string): Linha[] => [
  {
    organization_id: org,
    key: "interesse",
    label: "Interesse",
    type: "select",
    entidade: "contato",
    publico: true,
    descricao: null,
    config: { options: [{ value: "moradia", label: "Moradia" }, { value: "invest", label: "Investimento" }] },
    position: 1,
  },
  { organization_id: org, key: "renda", label: "Renda", type: "currency", entidade: "contato", publico: true, descricao: null, config: {}, position: 2 },
  { organization_id: org, key: "visitou", label: "Já visitou", type: "boolean", entidade: "contato", publico: true, descricao: null, config: {}, position: 3 },
  { organization_id: org, key: "orcamento", label: "Orçamento", type: "number", entidade: "negocio", publico: true, descricao: null, config: {}, position: 4 },
  { organization_id: org, key: "nota_interna", label: "Nota interna", type: "text", entidade: "contato", publico: false, descricao: null, config: {}, position: 5 },
];

let tabelas: Record<string, Linha[]>;
let updates: Array<{ tabela: string; patch: Linha; filtros: Linha }>;
let rpcs: Array<{ nome: string; args: Linha }>;

beforeEach(() => {
  auditados.length = 0;
  updates = [];
  rpcs = [];
  tabelas = {
    custom_field_definitions: [...DEFINICOES(ORG), ...DEFINICOES(ORG_B)],
    crm_pipelines: [],
    crm_leads: [
      { id: NEGOCIO, organization_id: ORG, contact_id: CONTATO, pipeline_id: FUNIL, status: "open", custom_fields: { origem: "site" } },
      { id: "99999999-9999-4999-8999-999999999999", organization_id: ORG, contact_id: CONTATO, pipeline_id: FUNIL, status: "won", custom_fields: {} },
      // Mesmo contato, OUTRA organização: a leitura do negócio não pode achá-lo.
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organization_id: ORG_B, contact_id: CONTATO, pipeline_id: FUNIL, status: "open", custom_fields: {} },
    ],
    contacts: [
      { id: CONTATO, organization_id: ORG, custom_fields: { cidade: "Recife" }, is_personal: false, is_anonymized: false, tags: [] },
      { id: CONTATO_B, organization_id: ORG_B, custom_fields: {}, is_personal: false, is_anonymized: false, tags: [] },
    ],
  };
});
afterEach(() => vi.restoreAllMocks());

/** A escrita do negócio, na borda: registra a chamada e aplica o merge na linha. */
function espiarEscritaDoNegocio() {
  const chamadas: Array<{ lead_id: string; custom_fields: Linha; org: string }> = [];
  vi.spyOn(crmUpdateLead, "handler").mockImplementation(async (input, ctx) => {
    const i = input as { lead_id: string; custom_fields: Linha };
    chamadas.push({ lead_id: i.lead_id, custom_fields: i.custom_fields, org: ctx.organizationId });
    const linha = tabelas.crm_leads!.find((l) => l.id === i.lead_id && l.organization_id === ctx.organizationId)!;
    linha.custom_fields = { ...(linha.custom_fields as Linha), ...i.custom_fields };
    return { lead: { id: i.lead_id } };
  });
  return chamadas;
}

/** Banco falso: `eq` filtra de verdade, `update` grava na linha que os filtros alcançam. */
function bancoFalso() {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    let patch: Linha | null = null;
    const filtros: Linha = {};
    const resolver = () => {
      if (patch) {
        updates.push({ tabela, patch, filtros: { ...filtros } });
        for (const l of linhas) Object.assign(l, patch);
      }
      return { data: linhas, error: null };
    };
    const alvo: Record<string, unknown> = {
      eq: (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;
        linhas = linhas.filter((l) => l[coluna] === valor);
        return cadeia;
      },
      update: (p: Linha) => {
        patch = p;
        return cadeia;
      },
      maybeSingle: () => {
        const r = resolver();
        return Promise.resolve({ data: r.data[0] ?? null, error: null });
      },
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(resolver()).then(ok, falha),
    };
    const cadeia: unknown = new Proxy(alvo, { get: (t, p: string) => (p in t ? t[p] : () => cadeia) });
    return cadeia;
  };
  // `fn_contato_anotar_campos` como o banco faz: `custom_fields || p_campos`
  // sobre a linha VIGENTE da organização (o resto das RPCs é fogo-e-esquece).
  const rpc = (nome: string, args: Linha) => {
    if (nome !== "fn_contato_anotar_campos") return Promise.resolve({ data: null, error: null });
    rpcs.push({ nome, args });
    const linha = tabelas.contacts!.find((c) => c.organization_id === args.p_org && c.id === args.p_contato);
    if (!linha) return Promise.resolve({ data: null, error: null });
    linha.custom_fields = { ...(linha.custom_fields as Linha), ...(args.p_campos as Linha) };
    return Promise.resolve({ data: linha.custom_fields, error: null });
  };
  return { from, rpc };
}

function montar(toolIds: string[], contatoDoTurno?: string, pipelineIds: string[] = [FUNIL]) {
  const supabase = bancoFalso();
  const ator = { type: "ai_agent", id: "run-1", agent_id: "ag-1", role: "ai_operator" };
  return pickToolsFromMcp({
    toolIds,
    auth: { organizationId: ORG, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor: ator, apiTokenId: "tok-1" },
    ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: "tok-1", requestId: "req-1", supabase },
    supabase,
    modulosLigados: MODULOS_OPCIONAIS,
    capacidadesLigadas: CAPACIDADES_DA_ORGANIZACAO,
    handoffToolEnabled: true,
    handoffSignal: { triggered: false },
    pipelineIds,
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  } as never);
}

async function gravar(campos: Linha, contatoDoTurno: string | null = CONTATO, pipelineIds?: string[]) {
  const ferramentas = montar([NOME], contatoDoTurno ?? undefined, pipelineIds);
  return (await ferramentas[NOME]!.execute!({ campos }, { toolCallId: "c1", messages: [] } as never)) as Linha;
}

const fichaDe = (id: string) => tabelas.contacts!.find((c) => c.id === id)!;

describe("crm_set_custom_field — a escrita", () => {
  it("grava a opção pelo RÓTULO, sem diferenciar maiúsculas, e mescla com as outras chaves", async () => {
    const r = await gravar({ interesse: "moradia", renda: "4.500,00", visitou: "sim" });
    expect(r.gravado).toBe(true);
    expect(fichaDe(CONTATO).custom_fields).toEqual({ cidade: "Recife", interesse: "moradia", renda: 4500, visitou: true });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filtros).toMatchObject({ organization_id: ORG, id: CONTATO });
  });

  it("mescla NO BANCO só as chaves que mudam: a edição humana feita ao mesmo tempo sobrevive", async () => {
    const r = await gravar({ interesse: "Moradia" });
    expect(r.gravado).toBe(true);
    // O UPDATE do PostgREST não leva o mapa: quem mescla é a função.
    expect(updates[0]!.patch).not.toHaveProperty("custom_fields");
    expect(rpcs).toEqual([
      { nome: "fn_contato_anotar_campos", args: { p_org: ORG, p_contato: CONTATO, p_campos: { interesse: "moradia" } } },
    ]);
    // Uma pessoa gravou `cidade` DEPOIS da leitura do agente: o merge no banco
    // não a apaga, porque o agente nunca reenviou o mapa que leu.
    fichaDe(CONTATO).custom_fields = { ...(fichaDe(CONTATO).custom_fields as Linha), cidade: "Olinda" };
    await gravar({ visitou: "sim" });
    expect(fichaDe(CONTATO).custom_fields).toEqual({ cidade: "Olinda", interesse: "moradia", visitou: true });
  });

  it("aceita o rótulo com outra caixa e grava o valor canônico da opção", async () => {
    await gravar({ interesse: "INVESTIMENTO" });
    expect(fichaDe(CONTATO).custom_fields).toMatchObject({ interesse: "invest" });
  });

  it("audita como a ficha: contact.updated com o ator do agente", async () => {
    await gravar({ interesse: "Moradia" });
    const linha = auditados.find((a) => a.action === "contact.updated");
    expect(linha).toBeDefined();
    expect(linha!.resourceId).toBe(CONTATO);
    expect(linha!.organizationId).toBe(ORG);
    expect(linha!.metadata).toMatchObject({ actor_type: "ai_agent", fields: ["custom_fields"] });
  });

  it("recusa chave inexistente, listando as disponíveis, e não grava", async () => {
    const r = await gravar({ cor_favorita: "azul" });
    expect(r.gravado).toBe(false);
    expect(String(r.erro_de_ensino)).toContain("interesse");
    expect(updates).toHaveLength(0);
  });

  it("campo restrito responde como inexistente, sem revelar o rótulo, e não grava", async () => {
    const r = await gravar({ nota_interna: "vip" });
    expect(r.gravado).toBe(false);
    expect((r.campos_nao_gravados as Linha[]).map((x) => x.motivo)).toEqual(["campo_inexistente"]);
    expect(JSON.stringify(r)).not.toContain("Nota interna");
    expect(updates).toHaveLength(0);
  });

  it("recusa opção que não existe, citando as opções, e grava o resto da chamada", async () => {
    const r = await gravar({ interesse: "Comércio", visitou: "não" });
    expect(r.gravado).toBe(true);
    expect((r.campos_nao_gravados as Linha[])[0]).toMatchObject({ campo: "interesse", motivo: "opcao_invalida" });
    expect(String(r.erro_de_ensino)).toContain("Moradia");
    expect(fichaDe(CONTATO).custom_fields).toEqual({ cidade: "Recife", visitou: false });
  });

  it("sem contato do turno (rota de fora da conversa), recusa e não grava", async () => {
    const r = await gravar({ interesse: "Moradia" }, null);
    expect(r).toMatchObject({ gravado: false, motivo: "sem_conversa" });
    expect(updates).toHaveLength(0);
  });

  it("não alcança contato de OUTRA organização, mesmo que seja o 'contato do turno'", async () => {
    const r = await gravar({ interesse: "Moradia" }, CONTATO_B);
    expect(r).toMatchObject({ gravado: false });
    expect((r.campos_nao_gravados as Linha[])[0]).toMatchObject({ motivo: "contato_nao_encontrado" });
    expect(fichaDe(CONTATO_B).custom_fields).toEqual({});
    expect(updates).toHaveLength(0);
  });

  it("não tem argumento de contato: o modelo não escolhe em quem grava", () => {
    expect(Object.keys(crmSetCustomField.inputSchema)).toEqual(["campos"]);
  });

  it("contato pessoal recusa", async () => {
    fichaDe(CONTATO).is_personal = true;
    const r = await gravar({ interesse: "Moradia" });
    expect(r).toMatchObject({ gravado: false });
    expect((r.campos_nao_gravados as Linha[])[0]).toMatchObject({ motivo: "contato_pessoal" });
    expect(updates).toHaveLength(0);
  });

  it("valor igual ao gravado não regrava nem audita", async () => {
    fichaDe(CONTATO).custom_fields = { interesse: "moradia" };
    const r = await gravar({ interesse: "Moradia" });
    expect(r).toMatchObject({ gravado: true, sem_mudanca: true });
    expect(updates).toHaveLength(0);
    expect(auditados).toHaveLength(0);
  });

  it("duas chamadas paralelas no mesmo contato não se apagam", async () => {
    const ferramentas = montar([NOME], CONTATO);
    const exec = ferramentas[NOME]!.execute!;
    await Promise.all([
      exec({ campos: { interesse: "Moradia" } }, { toolCallId: "a", messages: [] } as never),
      exec({ campos: { visitou: "sim" } }, { toolCallId: "b", messages: [] } as never),
    ]);
    expect(fichaDe(CONTATO).custom_fields).toEqual({ cidade: "Recife", interesse: "moradia", visitou: true });
  });
});

describe("crm_set_custom_field — campo do NEGÓCIO vai para o negócio aberto", () => {
  it("grava no único negócio ABERTO do contato, e não na ficha do contato", async () => {
    const chamadas = espiarEscritaDoNegocio();
    const r = await gravar({ orcamento: "250000", interesse: "Moradia" });
    expect(r.gravado).toBe(true);
    expect(chamadas).toEqual([{ lead_id: NEGOCIO, custom_fields: { orcamento: 250000 }, org: ORG }]);
    expect(fichaDe(CONTATO).custom_fields).toEqual({ cidade: "Recife", interesse: "moradia" });
    expect(tabelas.crm_leads!.find((l) => l.id === NEGOCIO)!.custom_fields).toEqual({ origem: "site", orcamento: 250000 });
  });

  it("sem negócio aberto, recusa o campo do negócio e grava o do contato", async () => {
    const chamadas = espiarEscritaDoNegocio();
    tabelas.crm_leads = tabelas.crm_leads!.filter((l) => l.id !== NEGOCIO);
    const r = await gravar({ orcamento: 1, interesse: "Moradia" });
    expect(r.gravado).toBe(true);
    expect(chamadas).toHaveLength(0);
    expect((r.campos_nao_gravados as Linha[])[0]).toMatchObject({ campo: "orcamento", motivo: "sem_negocio_aberto" });
  });

  it("com dois negócios abertos, não escolhe por palpite", async () => {
    const chamadas = espiarEscritaDoNegocio();
    tabelas.crm_leads!.push({ id: NEGOCIO_2, organization_id: ORG, contact_id: CONTATO, pipeline_id: FUNIL, status: "open", custom_fields: {} });
    const r = await gravar({ orcamento: 1 });
    expect(r).toMatchObject({ gravado: false });
    expect((r.campos_nao_gravados as Linha[])[0]).toMatchObject({ motivo: "negocio_ambiguo" });
    expect(chamadas).toHaveLength(0);
  });

  it("negócio num funil fora do escopo do agente: recusa e não grava", async () => {
    const chamadas = espiarEscritaDoNegocio();
    const r = await gravar({ orcamento: 1 }, CONTATO, [OUTRO_FUNIL]);
    expect(r.gravado).toBe(false);
    expect((r.campos_nao_gravados as Linha[])[0]).toMatchObject({ motivo: "funil_fora_do_escopo" });
    expect(chamadas).toHaveLength(0);
  });

  it("agente sem funil nenhum liberado: recusa o campo do negócio, mas grava o do contato", async () => {
    const chamadas = espiarEscritaDoNegocio();
    const r = await gravar({ orcamento: 1, visitou: "sim" }, CONTATO, []);
    expect(r.gravado).toBe(true);
    expect((r.campos_nao_gravados as Linha[])[0]).toMatchObject({ campo: "orcamento", motivo: "escopo_vazio" });
    expect(chamadas).toHaveLength(0);
    expect(fichaDe(CONTATO).custom_fields).toMatchObject({ visitou: true });
  });

  it("valor igual ao gravado no negócio não regrava (sem gravação em dobro)", async () => {
    const chamadas = espiarEscritaDoNegocio();
    await gravar({ orcamento: 300 });
    const r = await gravar({ orcamento: "300" });
    expect(r).toMatchObject({ gravado: true, sem_mudanca: true });
    expect(chamadas).toHaveLength(1);
  });

  it("não alcança o negócio de OUTRA organização com o mesmo contato", async () => {
    const chamadas = espiarEscritaDoNegocio();
    tabelas.crm_leads = tabelas.crm_leads!.filter((l) => l.id !== NEGOCIO);
    const r = await gravar({ orcamento: 1 });
    expect((r.campos_nao_gravados as Linha[])[0]).toMatchObject({ motivo: "sem_negocio_aberto" });
    expect(chamadas).toHaveLength(0);
  });
});

describe("crm_set_custom_field — ligar e desligar", () => {
  it("está no catálogo, como escrita, num pacote", () => {
    const entrada = catalogEntry(NOME);
    expect(entrada?.category).toBe("write");
    expect(entrada?.pacotes.length).toBeGreaterThan(0);
  });

  it("desligada na versão do agente, não é montada no turno", () => {
    expect(montar(["crm_get_contact"], CONTATO)[NOME]).toBeUndefined();
    expect(montar([NOME], CONTATO)[NOME]).toBeDefined();
  });
});

describe("conversão e descrição (puras)", () => {
  const campos = DEFINICOES(ORG).map((d) => ({
    key: d.key as string,
    label: d.label as string,
    type: d.type as never,
    entidade: d.entidade as never,
    publico: d.publico as boolean,
    descricao: null,
    config: d.config as Record<string, unknown>,
  }));
  const campo = (k: string) => campos.find((c) => c.key === k)!;

  it("converte número, data e sim/não; recusa formato errado e arquivo", () => {
    expect(converterValorDoCampo({ ...campo("renda"), type: "number" }, "12")).toEqual({ ok: true, valor: 12 });
    expect(converterValorDoCampo({ ...campo("renda"), type: "date" }, "05/03/2026")).toEqual({ ok: true, valor: "2026-03-05" });
    expect(converterValorDoCampo(campo("visitou"), "talvez").ok).toBe(false);
    expect(converterValorDoCampo({ ...campo("renda"), type: "file" }, "x")).toMatchObject({ ok: false, motivo: "tipo_nao_suportado" });
  });

  it("texto tem teto", () => {
    const texto = { ...campo("renda"), type: "text" as never };
    expect(converterValorDoCampo(texto, "a".repeat(501)).ok).toBe(false);
    expect(converterValorDoCampo(texto, "  ok  ")).toEqual({ ok: true, valor: "ok" });
  });

  it("a descrição lista os campos das duas entidades, cada um sob onde é gravado", () => {
    const d = descricaoComOsCampos("Base.", campos);
    expect(d).toContain("- interesse (uma opção) «Interesse»: opções «Moradia», «Investimento»");
    expect(d).toContain("- renda (");
    const contato = d.indexOf("Campos do CONTATO");
    const negocio = d.indexOf("Campos do NEGÓCIO");
    expect(contato).toBeGreaterThan(-1);
    expect(negocio).toBeGreaterThan(contato);
    expect(d.indexOf("- orcamento (")).toBeGreaterThan(negocio);
    expect(d.indexOf("- interesse (")).toBeLessThan(negocio);
    expect(d).not.toContain("nota_interna");
    expect(camposGravaveisPeloAgente(campos).map((c) => c.key)).toEqual(["interesse", "renda", "visitou", "orcamento"]);
  });

  it("sem campos, a descrição diz para não usar", () => {
    expect(descricaoComOsCampos("Base.", [])).toContain("não use esta ferramenta");
  });
});
