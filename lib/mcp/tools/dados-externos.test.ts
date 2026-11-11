import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: vi.fn() }));
// O CPF mora cifrado no CRM e abre por RPC do banco: o limite do teste é esse.
vi.mock("@/lib/contacts/cpf-do-contato", () => ({ decifrarCpfDoContato: vi.fn() }));

import { decifrarCpfDoContato } from "@/lib/contacts/cpf-do-contato";
import { abrirAcesso } from "@/lib/external-db/acesso";
import type { Dialeto } from "@/lib/external-db/dialeto";
import { FonteNaoLiberadaError } from "@/lib/external-db/dialeto";
import { LeituraInvalidaError, montarConsulta } from "@/lib/external-db/leitura";
import type { ConexaoExterna, TabelaExterna } from "@/lib/external-db/types";
import type { McpContext } from "@/lib/mcp/types";

import { crmDescribeExternalData, crmQueryExternalData, motivoDoVazioExterno } from "./dados-externos";

/** O dialeto de mentira: as chamadas viram `vi.fn()` e cada teste decide o que respondem. */
const dialeto = {
  listarTabelas: vi.fn(),
  colunasDaTabela: vi.fn(),
  lerTabela: vi.fn(),
  catalogoCompleto: vi.fn(),
  schemaDasReceitas: vi.fn(() => "public"),
  executarReceita: vi.fn(),
} satisfies { [K in keyof Dialeto]: ReturnType<typeof vi.fn> };
const listarTabelas = dialeto.listarTabelas;
const colunasDaTabela = dialeto.colunasDaTabela;
const lerTabela = dialeto.lerTabela;

const CONEXAO: ConexaoExterna = {
  id: "conn-1",
  organizationId: "org-1",
  dbType: "postgres",
  label: "Outro CRM",
  host: "db.exemplo.com",
  port: 5432,
  database: "outro_crm",
  username: "leitor",
  password: "segredo",
  sslMode: "require",
  maxRows: 200,
  maxFilters: 20,
  maxResponseBytes: 30_000,
  chaveDoCliente: null,
  sourceMode: "all",
  fontes: [],
  versao: "2026-09-11T00:00:00.000Z",
};

const TABELA: TabelaExterna = {
  schema: "public",
  nome: "assinaturas",
  tipo: "tabela",
  colunas: [
    { nome: "id", tipo: "uuid", nulavel: false, posicao: 1 },
    { nome: "status", tipo: "text", nulavel: true, posicao: 2 },
  ],
  chavePrimaria: ["id"],
  estimativaLinhas: 4200,
};

function ctxFake(
  conexoes: Array<{ id: string; label: string; db_type: string }> = [{ id: "conn-1", label: "Outro CRM", db_type: "postgres" }],
) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: async () => ({ data: conexoes, error: null }),
  };
  return {
    organizationId: "org-1",
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: { from: () => chain },
  } as unknown as McpContext;
}

beforeEach(() => {
  vi.mocked(abrirAcesso).mockReset();
  vi.mocked(listarTabelas).mockReset();
  vi.mocked(colunasDaTabela).mockReset();
  vi.mocked(lerTabela).mockReset();
  vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: CONEXAO, dialeto: dialeto as unknown as Dialeto });
  vi.mocked(listarTabelas).mockResolvedValue([TABELA]);
  vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "status"]));
});

describe("crm_describe_external_data", () => {
  it("é leitura e não exige papel acima do agente", () => {
    expect(crmDescribeExternalData.category).toBe("read");
    expect(crmDescribeExternalData.requiresScope).toBe("mcp:read");
    expect(crmDescribeExternalData.requiresRole).toBe("agent");
  });

  it("resolve a única conexão ativa e descreve as tabelas", async () => {
    const r = (await crmDescribeExternalData.handler({}, ctxFake())) as Record<string, unknown>;
    expect(r.tabelas).toHaveLength(1);
    expect((r.tabelas as TabelaExterna[])[0]?.nome).toBe("assinaturas");
    expect((r.tabelas as Array<{ chave: string[] }>)[0]?.chave).toEqual(["id"]);
  });

  it("a resposta traz o motor da conexão", async () => {
    const r = (await crmDescribeExternalData.handler({}, ctxFake())) as Record<string, unknown>;
    expect((r.conexao as { motor: string }).motor).toBe("postgres");
  });

  it("filtra por nome de tabela e devolve vazio quando não acha", async () => {
    const tabelas = [
      TABELA,
      { ...TABELA, nome: "pedidos", chavePrimaria: ["id"] },
    ];
    vi.mocked(listarTabelas).mockResolvedValue(tabelas);

    const ok = (await crmDescribeExternalData.handler({ tabela: "ped" }, ctxFake())) as Record<
      string,
      unknown
    >;
    expect((ok.tabelas as TabelaExterna[]).map((t) => t.nome)).toEqual(["pedidos"]);

    const nada = (await crmDescribeExternalData.handler({ tabela: "inexistente" }, ctxFake())) as Record<
      string,
      unknown
    >;
    expect(nada.erro).toBe("tabela_nao_encontrada");
  });

  it("com mais de uma conexão e sem id, pede para escolher", async () => {
    const ctx = ctxFake([
      { id: "a", label: "A", db_type: "postgres" },
      { id: "b", label: "B", db_type: "postgres" },
    ]);
    const r = (await crmDescribeExternalData.handler({}, ctx)) as Record<string, unknown>;
    expect(r.erro).toBe("conexao_ambigua");
    expect(r.conexoes).toEqual([
      { id: "a", label: "A", motor: "postgres" },
      { id: "b", label: "B", motor: "postgres" },
    ]);
  });

  it("sem conexão ativa, explica em vez de lançar", async () => {
    const r = (await crmDescribeExternalData.handler({}, ctxFake([]))) as Record<string, unknown>;
    expect(r.erro).toBe("sem_conexao");
  });

  it("módulo desligado na hora de abrir o acesso: mensagem própria, não o 'não foi possível' genérico", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: false, motivo: "modulo_desligado" });
    const r = (await crmDescribeExternalData.handler({}, ctxFake())) as Record<string, unknown>;
    expect(r.erro).toBe("acesso_negado");
    expect(String(r.mensagem)).toContain("módulo");
    expect(String(r.mensagem)).not.toBe("não foi possível abrir a conexão.");
  });
});

describe("crm_query_external_data", () => {
  it("é leitura, usa scope de leitura e redige os valores de filtro no audit", () => {
    expect(crmQueryExternalData.category).toBe("read");
    expect(crmQueryExternalData.requiresScope).toBe("mcp:read");
    const redigido = crmQueryExternalData.redigirParaAuditoria?.({
      tabela: "assinaturas",
      filtros: [{ coluna: "email", operador: "eq", valor: "cliente@exemplo.com" }],
    }) as { filtros: Array<Record<string, unknown>> };
    expect(redigido.filtros[0]).toEqual({ coluna: "email", operador: "eq" });
    expect(JSON.stringify(redigido)).not.toContain("cliente@exemplo.com");
  });

  it("recusa tabela inexistente sem tocar no banco", async () => {
    vi.mocked(colunasDaTabela).mockResolvedValue(null);
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "nao_existe", limite: 20 },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("tabela_nao_encontrada");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("pedido inválido (coluna/operador) vira erro de ensino, não exceção", async () => {
    vi.mocked(lerTabela).mockRejectedValue(new LeituraInvalidaError("coluna_inexistente:senha"));
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [{ coluna: "senha", operador: "eq", valor: "x" }],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("pedido_invalido");
  });

  it("devolve as linhas e marca truncagem por orçamento de bytes", async () => {
    const grandona = { id: "1", status: "x".repeat(20_000) };
    vi.mocked(lerTabela).mockResolvedValue({
      colunas: ["id", "status"],
      linhas: [grandona, grandona],
      limite: 20,
      offset: 0,
    });
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "assinaturas", limite: 20 },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.linhas).toHaveLength(1);
    expect(r.truncado).toBe(true);
    expect(r.aviso).toBeTruthy();
  });

  it("a resposta traz o motor da conexão", async () => {
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 20, offset: 0 });
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "assinaturas", limite: 20 },
      ctxFake(),
    )) as Record<string, unknown>;
    expect((r.conexao as { motor: string }).motor).toBe("postgres");
  });

  it("descobre o schema quando ele não é informado e há só uma candidata", async () => {
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 20, offset: 0 });
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", tabela: "assinaturas", limite: 20 },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.schema).toBe("public");
    expect(r.aviso).toBeTruthy();
  });

  it("usa o teto de linhas DA CONEXÃO, não o pedido pelo modelo", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({
      ok: true,
      conexao: { ...CONEXAO, maxRows: 150 },
      dialeto: dialeto as unknown as Dialeto,
    });
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 150, offset: 0 });

    await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "assinaturas", limite: 5000 },
      ctxFake(),
    );

    const chamada = vi.mocked(lerTabela).mock.calls[0];
    expect((chamada?.[0] as { limite: number } | undefined)?.limite).toBe(150);
    expect(chamada?.[2]).toEqual({ limiteMax: 150 });
  });

  it("recusa quando os filtros passam do teto DA CONEXÃO", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({
      ok: true,
      conexao: { ...CONEXAO, maxFilters: 2 },
      dialeto: dialeto as unknown as Dialeto,
    });
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [
          { coluna: "id", operador: "eq", valor: 1 },
          { coluna: "status", operador: "eq", valor: "ok" },
          { coluna: "id", operador: "ne", valor: 2 },
        ],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("limite_de_filtros");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  // Achado ao vivo (2026-09-19): o modelo mandava `{ coluna:"nome", operador:"contem" }`
  // SEM `valor` para buscar "CB 250". A versão anterior descartava o filtro em
  // silêncio e devolvia o catálogo inteiro — o turno seguia `success: true` e o
  // agente escolhia a moto no olho, sem a busca que o cliente pediu.
  it("filtro de comparação SEM valor vira erro de ensino, nunca catálogo inteiro", async () => {
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [{ coluna: "status", operador: "contem" }],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("filtro_sem_valor");
    expect(String(r.mensagem)).toContain("valor");
    // não toca o banco: sem valor, não há o que buscar
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("`nulo`/`nao_nulo` continuam válidos sem valor (ausência por definição)", async () => {
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 20, offset: 0 });
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [{ coluna: "status", operador: "nao_nulo" }],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBeUndefined();
    expect(lerTabela).toHaveBeenCalled();
  });

  // A versão do #1130 reexecutava SEM filtro quando nada casava e entregava até
  // 100 linhas ao modelo. Numa tabela de clientes, o CPF que não casa mostraria
  // os registros de outras pessoas. Aqui o vazio fica vazio.
  it("filtro que não casa nada devolve vazio, nunca a tabela sem o filtro", async () => {
    // A 2ª leitura teria linha: é o registro de outra pessoa que não pode vazar.
    vi.mocked(lerTabela)
      .mockResolvedValueOnce({ colunas: ["id"], linhas: [], limite: 20, offset: 0 })
      .mockResolvedValue({ colunas: ["id"], linhas: [{ id: "de-outra-pessoa" }], limite: 20, offset: 0 });
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [{ coluna: "status", operador: "eq", valor: "nao-existe" }],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.linhas).toEqual([]);
    expect(r.filtro_sem_resultado).toBeTruthy();
    expect(lerTabela).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lerTabela).mock.calls[0]![0].filtros).toHaveLength(1);
  });

  // Tabela criada por ORM com maiúscula ("Pedido"): o modelo escreve `pedido`.
  // A busca no catálogo compara em minúscula e ACHA; a conferência de colunas e a
  // consulta usavam o texto do MODELO e comparavam por igualdade exata — o agente
  // recebia "essa tabela não existe" para uma tabela que existe.
  describe("nome da tabela com maiúscula", () => {
    const PEDIDO: TabelaExterna = { ...TABELA, nome: "Pedido" };

    beforeEach(() => {
      vi.mocked(listarTabelas).mockResolvedValue([PEDIDO]);
      // Só o nome REAL existe para o catálogo: igualdade exata, como o SQL de verdade.
      vi.mocked(colunasDaTabela).mockImplementation(async (_schema, tabela) =>
        tabela === "Pedido" ? new Set(["id", "status"]) : null,
      );
      vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [{ id: "1" }], limite: 20, offset: 0 });
    });

    it("sem schema: acha `Pedido` pedido como `pedido` e consulta pelo nome real", async () => {
      const r = (await crmQueryExternalData.handler(
        { connection_id: "conn-1", tabela: "pedido", limite: 20 },
        ctxFake(),
      )) as Record<string, unknown>;
      expect(r.erro).toBeUndefined();
      expect(r.tabela).toBe("Pedido");
      expect(vi.mocked(lerTabela).mock.calls[0]![0].tabela).toBe("Pedido");
    });

    it("com schema informado e tabela em minúscula: cai no catálogo e usa o nome real", async () => {
      const r = (await crmQueryExternalData.handler(
        { connection_id: "conn-1", schema: "public", tabela: "pedido", limite: 20 },
        ctxFake(),
      )) as Record<string, unknown>;
      expect(r.erro).toBeUndefined();
      expect(r.tabela).toBe("Pedido");
      expect(vi.mocked(lerTabela).mock.calls[0]![0].tabela).toBe("Pedido");
    });

    it("duas candidatas em schemas diferentes: continua preferindo `public` e devolve o nome da escolhida", async () => {
      vi.mocked(listarTabelas).mockResolvedValue([
        { ...TABELA, schema: "outro", nome: "pedido" },
        { ...TABELA, schema: "public", nome: "Pedido" },
      ]);
      vi.mocked(colunasDaTabela).mockImplementation(async (schema, tabela) =>
        schema === "public" && tabela === "Pedido" ? new Set(["id"]) : schema === "outro" && tabela === "pedido" ? new Set(["id"]) : null,
      );
      const r = (await crmQueryExternalData.handler(
        { connection_id: "conn-1", tabela: "PEDIDO", limite: 20 },
        ctxFake(),
      )) as Record<string, unknown>;
      expect(r.schema).toBe("public");
      expect(r.tabela).toBe("Pedido");
    });

    it("`Pedido` e `pedido` no mesmo schema: quem pede `pedido` lê `pedido`, não a vizinha de outra caixa", async () => {
      vi.mocked(listarTabelas).mockResolvedValue([
        { ...TABELA, schema: "public", nome: "Pedido" },
        { ...TABELA, schema: "public", nome: "pedido" },
      ]);
      vi.mocked(colunasDaTabela).mockImplementation(async (schema, tabela) =>
        schema === "public" && (tabela === "Pedido" || tabela === "pedido") ? new Set(["id"]) : null,
      );
      await crmQueryExternalData.handler({ connection_id: "conn-1", tabela: "pedido", limite: 20 }, ctxFake());
      expect(vi.mocked(lerTabela).mock.calls[0]![0].tabela).toBe("pedido");
    });

    it("tabela que não existe em nenhuma caixa continua `tabela_nao_encontrada`", async () => {
      const r = (await crmQueryExternalData.handler(
        { connection_id: "conn-1", tabela: "fatura", limite: 20 },
        ctxFake(),
      )) as Record<string, unknown>;
      expect(r.erro).toBe("tabela_nao_encontrada");
      expect(lerTabela).not.toHaveBeenCalled();
    });
  });
});

describe("motivoDoVazioExterno — o audit não conta erro como sucesso (#484)", () => {
  it("erro devolvido ao modelo e consulta sem linha viram motivo; resposta com linha, não", () => {
    expect(motivoDoVazioExterno({ erro: "acesso_negado", mensagem: "x" })).toBe("acesso_negado");
    expect(motivoDoVazioExterno({ linhas: [], linhas_devolvidas: 0 })).toBe("nenhuma_linha");
    expect(motivoDoVazioExterno({ linhas: [{ id: 1 }], linhas_devolvidas: 1 })).toBeNull();
    expect(motivoDoVazioExterno({ tabelas: [] })).toBeNull();
    expect(crmQueryExternalData.motivoDoVazio).toBe(motivoDoVazioExterno);
    expect(crmDescribeExternalData.motivoDoVazio).toBe(motivoDoVazioExterno);
  });
});

describe("crm_query_external_data durante a conversa: só as linhas do cliente", () => {
  // `contatoDoTurno` é contexto de confiança do runtime; o valor do filtro sai
  // do cadastro do contato, nunca do modelo.
  const PEDIDO = { connection_id: "conn-1", schema: "public", tabela: "assinaturas", limite: 20 };
  // Na conversa, só com tabela liberada (D-146); a fonte não escolheu a coluna
  // do cliente, então vale a coluna da conexão (comportamento anterior).
  const LEGADA: ConexaoExterna = {
    ...CONEXAO,
    sourceMode: "list",
    fontes: [{ schema: "public", tabela: "assinaturas", colunas: null, descricao: "" }],
  };
  const COM_CHAVE: ConexaoExterna = { ...LEGADA, chaveDoCliente: { coluna: "telefone", tipo: "phone" } };

  /** ctx de turno: registra os `.eq()` da leitura do contato para provar org + id. */
  function ctxDoTurno(contato: { phone_number: string | null; email: string | null } | null) {
    const eq: Array<[string, unknown]> = [];
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => {
        eq.push([c, v]);
        return chain;
      },
      order: async () => ({ data: [{ id: "conn-1", label: "Outro CRM" }], error: null }),
      maybeSingle: async () => ({ data: contato, error: null }),
    };
    const ctx = { ...ctxFake(), contatoDoTurno: "contato-1", supabase: { from: () => chain } } as unknown as McpContext;
    return { ctx, eq };
  }

  beforeEach(() => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: LEGADA, dialeto: dialeto as unknown as Dialeto });
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "status", "telefone", "email"]));
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 20, offset: 0 });
  });

  it("conexão sem a coluna configurada: a consulta segue como antes, sem filtro do cliente", async () => {
    const { ctx, eq } = ctxDoTurno({ phone_number: "+5511999998888", email: null });
    const r = (await crmQueryExternalData.handler(PEDIDO, ctx)) as Record<string, unknown>;
    expect(r.erro).toBeUndefined();
    expect(vi.mocked(lerTabela).mock.calls[0]![0].filtros).toEqual([]);
    // Sem coluna, o contato nem é lido.
    expect(eq).not.toContainEqual(["id", "contato-1"]);
  });

  it("com a coluna configurada, o filtro do cliente entra junto com o do modelo", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: COM_CHAVE, dialeto: dialeto as unknown as Dialeto });
    const { ctx, eq } = ctxDoTurno({ phone_number: "+5511999998888", email: null });
    // O modelo tenta o telefone de OUTRA pessoa: o filtro dele soma, não substitui.
    await crmQueryExternalData.handler(
      { ...PEDIDO, filtros: [{ coluna: "telefone", operador: "eq", valor: "5521988887777" }] },
      ctx,
    );
    expect(eq).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["id", "contato-1"],
      ]),
    );
    const pedido = vi.mocked(lerTabela).mock.calls[0]![0];
    expect(pedido.filtros).toEqual([
      { coluna: "telefone", operador: "eq", valor: "5521988887777" },
      { coluna: "telefone", operador: "in", valor: ["+5511999998888", "5511999998888", "11999998888"] },
    ]);
    // Parametrizado: o telefone do cliente vai nos values, nunca no texto do SQL.
    const sql = montarConsulta(pedido, new Set(["id", "status", "telefone"]));
    expect(sql.text).toContain('"telefone" in ($2, $3, $4)');
    expect(sql.text).not.toContain("5511999998888");
    expect(sql.text).toContain(" and ");
  });

  it("por e-mail, o valor é o do contato (e a forma minúscula)", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({
      ok: true,
      conexao: { ...LEGADA, chaveDoCliente: { coluna: "email", tipo: "email" } },
      dialeto: dialeto as unknown as Dialeto,
    });
    const { ctx } = ctxDoTurno({ phone_number: null, email: "Ana@Loja.com" });
    await crmQueryExternalData.handler(PEDIDO, ctx);
    expect(vi.mocked(lerTabela).mock.calls[0]![0].filtros).toEqual([
      { coluna: "email", operador: "in", valor: ["Ana@Loja.com", "ana@loja.com"] },
    ]);
  });

  it("tabela sem a coluna do cliente: recusa em vez de ler sem o filtro", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: COM_CHAVE, dialeto: dialeto as unknown as Dialeto });
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "status"]));
    const { ctx } = ctxDoTurno({ phone_number: "+5511999998888", email: null });
    const r = (await crmQueryExternalData.handler(PEDIDO, ctx)) as Record<string, unknown>;
    expect(r.erro).toBe("tabela_sem_identificador_do_cliente");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("contato sem o dado no cadastro: recusa", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: COM_CHAVE, dialeto: dialeto as unknown as Dialeto });
    const { ctx } = ctxDoTurno({ phone_number: null, email: "a@b.com" });
    const r = (await crmQueryExternalData.handler(PEDIDO, ctx)) as Record<string, unknown>;
    expect(r.erro).toBe("cliente_sem_identificador");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("CONTROLE: fora da conversa, a consulta segue sem filtro do cliente, configurada ou não", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: COM_CHAVE, dialeto: dialeto as unknown as Dialeto });
    await crmQueryExternalData.handler(PEDIDO, ctxFake());
    expect(vi.mocked(lerTabela).mock.calls[0]![0].filtros).toEqual([]);
  });
});

describe("fontes liberadas", () => {
  const SO_CLIENTES = { schema: "public", tabela: "assinaturas", colunas: null, descricao: "Quem assina" };

  const LISTA_VAZIA: ConexaoExterna = { ...CONEXAO, sourceMode: "list", fontes: [] };
  const COM_FONTE: ConexaoExterna = { ...CONEXAO, sourceMode: "list", fontes: [SO_CLIENTES] };

  function com(conexao: ConexaoExterna) {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao, dialeto: dialeto as unknown as Dialeto });
  }

  it("modo list sem nenhuma fonte: as DUAS tools respondem sem_fontes_liberadas e nem tocam o banco", async () => {
    com(LISTA_VAZIA);
    const d = (await crmDescribeExternalData.handler({}, ctxFake())) as Record<string, unknown>;
    const q = (await crmQueryExternalData.handler({ tabela: "assinaturas", limite: 20 }, ctxFake())) as Record<string, unknown>;
    expect(d.erro).toBe("sem_fontes_liberadas");
    expect(q.erro).toBe("sem_fontes_liberadas");
    expect(String(d.mensagem)).toContain("Integração de dados");
    expect(listarTabelas).not.toHaveBeenCalled();
    expect(lerTabela).not.toHaveBeenCalled();
    expect(motivoDoVazioExterno(d)).toBe("sem_fontes_liberadas");
  });

  it("describe em list devolve a descrição do administrador ao lado da tabela", async () => {
    com(COM_FONTE);
    vi.mocked(listarTabelas).mockResolvedValue([{ ...TABELA, descricao: "Quem assina" }]);
    const r = (await crmDescribeExternalData.handler({}, ctxFake())) as { tabelas: Array<{ descricao?: string }> };
    expect(r.tabelas[0]?.descricao).toBe("Quem assina");
  });

  it("describe respeita o teto de bytes da conexão e marca truncado", async () => {
    com({ ...CONEXAO, maxResponseBytes: 4_096 });
    const muitas: TabelaExterna[] = Array.from({ length: 40 }, (_, i) => ({
      ...TABELA,
      nome: `tabela_${i}`,
      colunas: Array.from({ length: 30 }, (_, j) => ({ nome: `campo_${j}`, tipo: "text", nulavel: true, posicao: j + 1 })),
    }));
    vi.mocked(listarTabelas).mockResolvedValue(muitas);
    const r = (await crmDescribeExternalData.handler({}, ctxFake())) as { tabelas: unknown[]; truncado?: boolean };
    expect(r.truncado).toBe(true);
    expect(r.tabelas.length).toBeGreaterThan(0);
    expect(r.tabelas.length).toBeLessThan(40);
    expect(JSON.stringify(r.tabelas).length).toBeLessThanOrEqual(4_096 + 4_000); // a primeira tabela sempre entra
  });

  it("query de tabela que não está na lista: fonte_nao_liberada (list) — e tabela_nao_encontrada continua em all", async () => {
    com(COM_FONTE);
    vi.mocked(colunasDaTabela).mockResolvedValue(null);
    vi.mocked(listarTabelas).mockResolvedValue([]);
    const emLista = (await crmQueryExternalData.handler({ tabela: "wp_users", limite: 20 }, ctxFake())) as Record<string, unknown>;
    expect(emLista.erro).toBe("fonte_nao_liberada");
    expect(String(emLista.mensagem)).toContain("crm_describe_external_data");
    expect(lerTabela).not.toHaveBeenCalled();

    com(CONEXAO);
    const emTudo = (await crmQueryExternalData.handler({ tabela: "wp_users", limite: 20 }, ctxFake())) as Record<string, unknown>;
    expect(emTudo.erro).toBe("tabela_nao_encontrada");
  });

  it("FonteNaoLiberadaError vinda do dialeto vira fonte_nao_liberada, não exceção", async () => {
    com(COM_FONTE);
    vi.mocked(lerTabela).mockRejectedValue(new FonteNaoLiberadaError("fonte_nao_liberada"));
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "assinaturas", limite: 20 },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("fonte_nao_liberada");
  });

  it("a lista esconde a coluna do cliente (#2280): a consulta na conversa FECHA, nunca lê sem o filtro", async () => {
    com({ ...COM_FONTE, chaveDoCliente: { coluna: "telefone", tipo: "phone" } });
    // O dialeto só devolve as colunas liberadas: `telefone` ficou de fora da lista.
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "status"]));
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: async () => ({ data: [{ id: "conn-1", label: "Outro CRM" }], error: null }),
      maybeSingle: async () => ({ data: { phone_number: "+5511999998888", email: null }, error: null }),
    };
    const ctx = { ...ctxFake(), contatoDoTurno: "contato-1", supabase: { from: () => chain } } as unknown as McpContext;
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "assinaturas", limite: 20 },
      ctx,
    )) as Record<string, unknown>;
    expect(r.erro).toBe("tabela_sem_identificador_do_cliente");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("LeituraInvalidaError por coluna escondida continua virando pedido_invalido", async () => {
    com(COM_FONTE);
    vi.mocked(lerTabela).mockRejectedValue(new LeituraInvalidaError("coluna_inexistente:cpf"));
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [{ coluna: "cpf", operador: "eq", valor: "1" }],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("pedido_invalido");
  });
});

describe("D-146: o que a IA pode consultar na conversa (regra por tabela)", () => {
  const PEDIDOS: TabelaExterna = {
    schema: "public",
    nome: "pedidos",
    tipo: "tabela",
    colunas: [
      { nome: "id", tipo: "int", nulavel: false, posicao: 1 },
      { nome: "total", tipo: "numeric", nulavel: true, posicao: 2 },
      { nome: "cpf", tipo: "text", nulavel: true, posicao: 3 },
      { nome: "telefone", tipo: "text", nulavel: true, posicao: 4 },
    ],
    chavePrimaria: ["id"],
    estimativaLinhas: 10,
  };
  const PRODUTOS: TabelaExterna = { ...PEDIDOS, nome: "produtos", colunas: PEDIDOS.colunas.slice(0, 2) };

  const REGRAS: ConexaoExterna = {
    ...CONEXAO,
    sourceMode: "list",
    fontes: [
      // Pedido é de cada cliente: a coluna `telefone` é a do cliente, e a IA nem enxerga `cpf`.
      {
        schema: "public",
        tabela: "pedidos",
        colunas: ["id", "total"],
        descricao: "",
        cliente: { coluna: "telefone", dado: "phone" },
      },
      { schema: "public", tabela: "pedidos_por_cpf", colunas: null, descricao: "", cliente: { coluna: "cpf", dado: "document" } },
      // Catálogo serve a qualquer cliente.
      { schema: "public", tabela: "produtos", colunas: null, descricao: "", cliente: null },
    ],
  };

  function ctxConversa(contato: { phone_number: string | null; email: string | null }) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: async () => ({ data: [{ id: "conn-1", label: "Outro CRM" }], error: null }),
      maybeSingle: async () => ({ data: contato, error: null }),
    };
    return {
      ...ctxFake(),
      contatoDoTurno: "contato-1",
      escopoDoTurno: { contatoId: "contato-1", externo: { conhecidos: new Set<string>() } },
      supabase: { from: () => chain },
    } as unknown as McpContext;
  }
  const ANA = { phone_number: "+5511999998888", email: "ana@loja.com" };

  beforeEach(() => {
    vi.mocked(decifrarCpfDoContato).mockReset();
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: REGRAS, dialeto: dialeto as unknown as Dialeto });
    vi.mocked(listarTabelas).mockResolvedValue([PEDIDOS, PRODUTOS, { ...PEDIDOS, nome: "pedidos_por_cpf" }]);
    // O dialeto (modo list) só devolve as colunas liberadas da fonte.
    vi.mocked(colunasDaTabela).mockImplementation(async (_s: string, t: string) =>
      t === "pedidos" ? new Set(["id", "total"]) : t === "produtos" ? new Set(["id", "total"]) : new Set(["id", "total", "cpf"]),
    );
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id", "total"], linhas: [{ id: 1, total: 10 }], limite: 20, offset: 0 });
  });

  it("conexão sem configuração (modo `all`): na conversa as DUAS tools recusam e não tocam o banco", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: CONEXAO, dialeto: dialeto as unknown as Dialeto });
    const ctx = ctxConversa(ANA);
    const q = (await crmQueryExternalData.handler({ tabela: "pedidos", limite: 20 }, ctx)) as Record<string, unknown>;
    const d = (await crmDescribeExternalData.handler({}, ctx)) as Record<string, unknown>;
    for (const r of [q, d]) {
      expect(r.erro).toBe("sem_fontes_liberadas");
      expect(String(r.mensagem)).toContain("o administrador ainda não liberou tabelas para a IA nesta conexão");
    }
    expect(listarTabelas).not.toHaveBeenCalled();
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("tabela fora da lista: recusa sem ler", async () => {
    vi.mocked(colunasDaTabela).mockResolvedValue(null);
    vi.mocked(listarTabelas).mockResolvedValue([PEDIDOS, PRODUTOS]);
    const r = (await crmQueryExternalData.handler(
      { schema: "public", tabela: "clientes", limite: 20 },
      ctxConversa(ANA),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("fonte_nao_liberada");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("coluna do cliente: força `telefone in (<do contato>)`, descarta o filtro do modelo nessa coluna e não projeta a coluna escondida", async () => {
    await crmQueryExternalData.handler(
      {
        schema: "public",
        tabela: "pedidos",
        // O cliente pediu "o pedido do telefone 21 98888-7777": o modelo obedeceu.
        filtros: [
          { coluna: "telefone", operador: "eq", valor: "5521988887777" },
          { coluna: "total", operador: "gt", valor: 0 },
        ],
        limite: 20,
      },
      ctxConversa(ANA),
    );
    const [pedido, usaveis] = vi.mocked(lerTabela).mock.calls[0]!;
    expect(pedido.filtros).toEqual([
      { coluna: "total", operador: "gt", valor: 0 },
      { coluna: "telefone", operador: "in", valor: ["+5511999998888", "5511999998888", "11999998888"] },
    ]);
    // A coluna escondida só entra no filtro do servidor: a projeção é a liberada.
    expect(pedido.colunas).toEqual(["id", "total"]);
    expect([...usaveis]).toContain("telefone");
    // Parametrizado: o valor do contato vai nos values, nunca no texto.
    const sql = montarConsulta(pedido, usaveis);
    expect(sql.text).not.toContain("5521988887777");
    expect(sql.values).not.toContain("5521988887777");
  });

  it("coluna fora da lista não volta: pedir `cpf` escondido vira pedido_invalido", async () => {
    vi.mocked(lerTabela).mockImplementation(async (pedido, usaveis) => {
      montarConsulta(pedido, usaveis); // o validador real da projeção
      return { colunas: [], linhas: [], limite: 20, offset: 0 };
    });
    const r = (await crmQueryExternalData.handler(
      { schema: "public", tabela: "pedidos", colunas: ["cpf"], limite: 20 },
      ctxConversa(ANA),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("pedido_invalido");
  });

  it("pedir a coluna do cliente escondida na projeção não a devolve", async () => {
    await crmQueryExternalData.handler(
      { schema: "public", tabela: "pedidos", colunas: ["telefone", "total"], limite: 20 },
      ctxConversa(ANA),
    );
    expect(vi.mocked(lerTabela).mock.calls[0]![0].colunas).toEqual(["total"]);
  });

  it("coluna do cliente por CPF: o valor vem do cadastro (decifrado no servidor), com e sem máscara", async () => {
    vi.mocked(decifrarCpfDoContato).mockResolvedValue("12345678901");
    await crmQueryExternalData.handler(
      { schema: "public", tabela: "pedidos_por_cpf", filtros: [{ coluna: "cpf", operador: "eq", valor: "99999999999" }], limite: 20 },
      ctxConversa(ANA),
    );
    expect(decifrarCpfDoContato).toHaveBeenCalledWith("org-1", "contato-1");
    expect(vi.mocked(lerTabela).mock.calls[0]![0].filtros).toEqual([
      { coluna: "cpf", operador: "in", valor: ["12345678901", "123.456.789-01"] },
    ]);
  });

  it("contato sem o dado da coluna do cliente: recusa sem ler", async () => {
    vi.mocked(decifrarCpfDoContato).mockResolvedValue(null);
    const semCpf = (await crmQueryExternalData.handler(
      { schema: "public", tabela: "pedidos_por_cpf", limite: 20 },
      ctxConversa(ANA),
    )) as Record<string, unknown>;
    const semTelefone = (await crmQueryExternalData.handler(
      { schema: "public", tabela: "pedidos", limite: 20 },
      ctxConversa({ phone_number: null, email: "ana@loja.com" }),
    )) as Record<string, unknown>;
    expect(semCpf.erro).toBe("cliente_sem_identificador");
    expect(String(semCpf.mensagem)).toContain("CPF");
    expect(semTelefone.erro).toBe("cliente_sem_identificador");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("tabela sem coluna do cliente (`cliente: null`): consulta normal, com o filtro do modelo e sem vínculo", async () => {
    const r = (await crmQueryExternalData.handler(
      { schema: "public", tabela: "produtos", filtros: [{ coluna: "total", operador: "lt", valor: 50 }], limite: 20 },
      ctxConversa(ANA),
    )) as Record<string, unknown>;
    expect(r.erro).toBeUndefined();
    expect(vi.mocked(lerTabela).mock.calls[0]![0].filtros).toEqual([{ coluna: "total", operador: "lt", valor: 50 }]);
  });

  it("describe na conversa marca a tabela que só devolve o cliente da conversa", async () => {
    vi.mocked(listarTabelas).mockResolvedValue([PEDIDOS, PRODUTOS]);
    const r = (await crmDescribeExternalData.handler({}, ctxConversa(ANA))) as { tabelas: Array<Record<string, unknown>> };
    expect(r.tabelas.find((t) => t.nome === "pedidos")?.so_do_cliente_da_conversa).toBe(true);
    expect(r.tabelas.find((t) => t.nome === "produtos")?.so_do_cliente_da_conversa).toBeUndefined();
  });

  it("CONTROLE: fora da conversa, a regra da tabela não se aplica (integrador lê como antes)", async () => {
    await crmQueryExternalData.handler({ schema: "public", tabela: "pedidos", limite: 20 }, ctxFake());
    expect(vi.mocked(lerTabela).mock.calls[0]![0].filtros).toEqual([]);
  });
});
