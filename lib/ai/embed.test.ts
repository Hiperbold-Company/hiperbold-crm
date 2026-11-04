/**
 * O que este teste protege, em duas frentes.
 *
 * **1. Sem gateway, o embedding não pode passar pelo gateway.**
 * O arquivo prometia esse caminho no cabeçalho desde que nasceu ("otherwise uses
 * the OpenAI provider directly") e não o tinha: passava a string
 * `openai/text-embedding-3-small` direto para `embed()`, e no AI SDK um id com
 * barra é resolvido pelo **gateway da Vercel mesmo sem chave** — entrando no
 * plano anônimo. O teto desse plano devolve `GatewayRateLimitError`, o `catch`
 * do `searchKnowledge` engole, e a busca na base volta vazia sem gravar nada.
 *
 * A asserção é sobre o TIPO do que chega em `embed({model})`: string significa
 * "deixa o gateway resolver"; objeto significa "provider explícito". É a única
 * diferença observável sem rede.
 *
 * **2. A chave vem da ORGANIZAÇÃO (0181).** Até aqui `embedText` lia só o
 * `process.env`, e o efeito era o pior possível para quem instala: cadastrar a
 * chave da OpenAI pela tela NÃO habilitava a base de conhecimento, enquanto duas
 * telas do produto prometiam que sim. Os casos abaixo cobrem os dois desfechos —
 * a chave da organização é usada, e a ausência dela vira erro TIPADO em vez de
 * uma falha genérica que a tela não sabe traduzir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embedSpy = vi.fn();
const embedManySpy = vi.fn();
vi.mock("ai", () => ({
  embed: (args: unknown) => embedSpy(args),
  embedMany: (args: unknown) => embedManySpy(args),
}));

// Tarefa 8 (Frente 2): `embedText`/`embedTexts` gravam telemetria em `llm_calls`.
// Mockado no nível do client, e não da função: para provar a integração real
// (o `insert` chega com os campos certos, e uma falha nele não derruba a
// chamada), não só que `embedText` "chamou algo".
const insertMock = vi.fn();
let insertDeveLancar = false;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (insertDeveLancar) throw new Error("conexão com o banco explodiu");
        insertMock(tabela, row);
        return { error: null };
      },
    }),
  }),
}));

let chaveMock: () => unknown;
vi.mock("@/lib/ai/embeddings/chave", async () => {
  const real =
    await vi.importActual<typeof import("@/lib/ai/embeddings/chave")>("@/lib/ai/embeddings/chave");
  return {
    ...real,
    // Mockado porque a resposta REAL depende de banco e de `.env.local`, e este
    // arquivo mede qual OBJETO DE MODELO chega em `embed()`. Sem isto ele só
    // passaria em máquina com credencial — refém de algo que não usa.
    resolverChaveDeEmbedding: async () => chaveMock(),
  };
});

import { embedText, embedTexts, SemChaveDeEmbeddingError } from "@/lib/ai/embed";

const vetor = (semente: number) => Array.from({ length: 1536 }, (_, i) => (i + semente) / 1536);

beforeEach(() => {
  insertMock.mockReset();
  insertDeveLancar = false;
  embedSpy.mockReset();
  embedManySpy.mockReset();
  embedManySpy.mockImplementation((args: { values: string[] }) => ({
    embeddings: args.values.map((_, i) => vetor(i)),
    usage: { tokens: 7 * args.values.length },
  }));
  embedSpy.mockResolvedValue({
    // 1536 dimensões: `embedText` assere a dimensão a cada chamada, porque
    // divergir de modelo quebra o recall em SILÊNCIO.
    embedding: Array.from({ length: 1536 }, (_, i) => i / 1536),
    usage: { tokens: 7 },
  });
  chaveMock = () => ({
    apiKey: "sk-da-organizacao",
    baseUrl: null,
    provedor: "openai",
    viaGateway: false,
    origem: "credencial_da_organizacao",
    rotulo: "Chave principal",
    avisos: [],
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("embedText", () => {
  it("SEM gateway, usa o provider OpenAI explícito — nunca a string com barra", async () => {
    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as { model: unknown; headers?: unknown };
    // String aqui = o gateway resolve = plano anônimo = teto. É o defeito.
    expect(
      typeof arg.model,
      "modelo chegou como string: o gateway vai resolver e cair no plano anônimo",
    ).not.toBe("string");
    expect(arg.model).toBeTypeOf("object");
    // Sem gateway não há tenant para observar: headers não fazem sentido.
    expect(arg.headers).toBeUndefined();
  });

  it("COM gateway, mantém a string (é ele quem roteia) e NÃO manda o id da organização ao provedor", async () => {
    chaveMock = () => ({
      apiKey: null,
      baseUrl: null,
      provedor: "gateway",
      viaGateway: true,
      origem: "gateway_da_instalacao",
      rotulo: null,
      avisos: [],
    });

    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as { model: unknown; headers?: Record<string, string> };
    expect(arg.model).toBe("openai/text-embedding-3-small");
    // Regra Hiperbold: o id da organização não vai ao provedor
    // (`tests/unit/id-da-organizacao-nao-vai-ao-provedor.test.ts`).
    expect(arg.headers).toBeUndefined();
  });

  it("chave da INSTALAÇÃO sai pela OpenRouter: provider explícito com o endereço dela e o id com fabricante", async () => {
    chaveMock = () => ({
      apiKey: "sk-or-instalacao",
      baseUrl: "https://openrouter.ai/api/v1",
      provedor: "openrouter",
      viaGateway: false,
      origem: "chave_da_instalacao",
      rotulo: null,
      avisos: [],
    });

    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as { model: { modelId?: string; provider?: string }; headers?: unknown };
    // Nunca a string com barra (que o AI SDK mandaria ao gateway da Vercel) e nunca a OpenAI direto.
    expect(typeof arg.model).toBe("object");
    expect(arg.model.modelId).toBe("openai/text-embedding-3-small");
    expect(arg.headers).toBeUndefined();
  });

  describe("plano B: OpenRouter falhou, OpenAI direto uma vez", () => {
    const chaveDaInstalacao = () => ({
      apiKey: "sk-or-instalacao",
      baseUrl: "https://openrouter.ai/api/v1",
      provedor: "openrouter",
      viaGateway: false,
      origem: "chave_da_instalacao",
      rotulo: null,
      avisos: [],
    });
    const erroHttp = (statusCode: number) => Object.assign(new Error("falhou"), { statusCode });
    const resposta = { embedding: Array.from({ length: 1536 }, () => 0.1), usage: { tokens: 5 } };

    it.each([[500], [503]])("HTTP %s na OpenRouter, com OPENAI_API_KEY: tenta a OpenAI direto e grava provider openai", async (status) => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-do-servidor");
      chaveMock = chaveDaInstalacao;
      embedSpy.mockReset();
      embedSpy.mockRejectedValueOnce(erroHttp(status)).mockResolvedValueOnce(resposta);

      const r = await embedText("oi", { organizationId: "org-1" });

      expect(r.embedding).toHaveLength(1536);
      expect(embedSpy).toHaveBeenCalledTimes(2);
      const segunda = embedSpy.mock.calls[1]?.[0] as { model: { modelId?: string } };
      expect(segunda.model.modelId).toBe("text-embedding-3-small");
      expect(insertMock.mock.calls[0]?.[1]).toMatchObject({ provider: "openai", origem_da_chave: "chave_da_instalacao" });
      vi.unstubAllEnvs();
    });

    it("erro de rede (sem status) também aciona o plano B", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-do-servidor");
      chaveMock = chaveDaInstalacao;
      embedSpy.mockReset();
      embedSpy.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce(resposta);
      await embedText("oi", { organizationId: "org-1" });
      expect(embedSpy).toHaveBeenCalledTimes(2);
      vi.unstubAllEnvs();
    });

    it.each([[400], [401], [402], [403], [404], [429]])(
      "HTTP %s NÃO aciona o plano B: é chave, saldo, limite ou pedido errado e precisa aparecer",
      async (status) => {
        vi.stubEnv("OPENAI_API_KEY", "sk-openai-do-servidor");
        chaveMock = chaveDaInstalacao;
        embedSpy.mockReset();
        embedSpy.mockRejectedValue(erroHttp(status));
        await expect(embedText("oi", { organizationId: "org-1" })).rejects.toMatchObject({ statusCode: status });
        expect(embedSpy).toHaveBeenCalledTimes(1);
        vi.unstubAllEnvs();
      },
    );

    it("429 embrulhado em RetryError (o SDK esgotou as tentativas) também NÃO aciona o plano B", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-do-servidor");
      chaveMock = chaveDaInstalacao;
      embedSpy.mockReset();
      embedSpy.mockRejectedValue(Object.assign(new Error("Failed after 3 attempts"), { lastError: erroHttp(429) }));
      await expect(embedText("oi", { organizationId: "org-1" })).rejects.toThrow("Failed after 3 attempts");
      expect(embedSpy).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    });

    it("quando o plano B é usado, deixa o rastro no log em nível error", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-do-servidor");
      chaveMock = chaveDaInstalacao;
      embedSpy.mockReset();
      embedSpy.mockRejectedValueOnce(erroHttp(503)).mockResolvedValueOnce(resposta);
      const erroLog = vi.spyOn(console, "error").mockImplementation(() => {});
      await embedText("oi", { organizationId: "org-1" });
      const linhas = erroLog.mock.calls.map((c) => String(c[0]));
      erroLog.mockRestore();
      expect(linhas.some((l) => l.includes('"level":"error"') && l.includes("plano B") && l.includes('"status":503'))).toBe(true);
      vi.unstubAllEnvs();
    });

    it("sem OPENAI_API_KEY no servidor, o erro da OpenRouter sobe como está", async () => {
      vi.stubEnv("OPENAI_API_KEY", "");
      chaveMock = chaveDaInstalacao;
      embedSpy.mockReset();
      embedSpy.mockRejectedValue(erroHttp(500));
      await expect(embedText("oi", { organizationId: "org-1" })).rejects.toMatchObject({ statusCode: 500 });
      expect(embedSpy).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    });

    it("tenta a OpenAI UMA vez só: se ela também falhar, o erro sobe (sem laço)", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-do-servidor");
      chaveMock = chaveDaInstalacao;
      embedSpy.mockReset();
      embedSpy.mockRejectedValue(erroHttp(500));
      await expect(embedText("oi", { organizationId: "org-1" })).rejects.toMatchObject({ statusCode: 500 });
      expect(embedSpy).toHaveBeenCalledTimes(2);
      vi.unstubAllEnvs();
    });

    it("a credencial da PRÓPRIA organização nunca tem plano B: o erro dela sobe", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-do-servidor");
      embedSpy.mockReset();
      embedSpy.mockRejectedValue(erroHttp(500));
      await expect(embedText("oi", { organizationId: "org-1" })).rejects.toMatchObject({ statusCode: 500 });
      expect(embedSpy).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    });
  });

  it("devolve a contagem de tokens que o SDK reporta", async () => {
    const r = await embedText("oi", { organizationId: "org-1" });
    expect(r.embedding).toHaveLength(1536);
    expect(r.promptTokens).toBe(7);
  });

  it("OpenRouter recebe o id completo do modelo fixo de embedding", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    chaveMock = () => ({
      apiKey: "chave-ficticia-openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      provedor: "openrouter",
      viaGateway: false,
      origem: "credencial_da_organizacao",
      rotulo: "OpenRouter",
      avisos: [],
    });

    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as {
      model: { modelId: string; doEmbed: (args: { values: string[] }) => Promise<unknown> };
    };
    expect(arg.model.modelId).toBe("openai/text-embedding-3-small");
    await arg.model.doEmbed({ values: ["oi"] });
    const [url, request] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "openai/text-embedding-3-small",
      input: ["oi"],
    });
    expect(request.headers).toMatchObject({ authorization: "Bearer chave-ficticia-openrouter" });
  });

  // #1130 (@vgamkt): a base pode ser preparada pelo Google. A pergunta-chave é a
  // DIMENSÃO: o Gemini devolve 3072 por padrão e a coluna é `vector(1536)`. O
  // caso mede o pedido que sai de verdade para o Google (via `doEmbed` com
  // `fetch` dublado), não só o objeto que montamos.
  it("Google: provider explícito, 1536 dimensões pedidas ao provedor e o par documento×pergunta", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      // Um valor só = `:embedContent`, cuja resposta é `{ embedding: { values } }`.
      embedding: { values: Array(1536).fill(0) },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    chaveMock = () => ({
      apiKey: "chave-ficticia-google",
      baseUrl: null,
      provedor: "google",
      viaGateway: false,
      origem: "binding_do_ponto",
      rotulo: "Google",
      avisos: [],
    });

    const r = await embedText("oi", { organizationId: "org-1", ponto: "embedding_consultar" });
    await embedText("oi", { organizationId: "org-1" });

    expect(r.model).toBe("google/gemini-embedding-001");
    const [consulta, indexacao] = embedSpy.mock.calls.map((c) => c[0]) as Array<{
      model: {
        modelId: string;
        doEmbed: (args: { values: string[]; providerOptions?: unknown }) => Promise<unknown>;
      };
      providerOptions?: { google?: Record<string, unknown> };
    }>;
    expect(consulta!.providerOptions?.google).toEqual({
      outputDimensionality: 1536,
      taskType: "RETRIEVAL_QUERY",
    });
    expect(indexacao!.providerOptions?.google?.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(consulta!.model.modelId).toBe("gemini-embedding-001");

    await consulta!.model.doEmbed({ values: ["oi"], providerOptions: consulta!.providerOptions });
    const [url, request] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("gemini-embedding-001");
    expect(JSON.stringify(JSON.parse(String(request.body)))).toContain('"outputDimensionality":1536');
    expect(request.headers).toMatchObject({ "x-goog-api-key": "chave-ficticia-google" });
  });

  it("OpenAI não recebe opção do Google", async () => {
    await embedText("oi", { organizationId: "org-1", ponto: "embedding_consultar" });
    const arg = embedSpy.mock.calls[0]?.[0] as { providerOptions?: unknown };
    expect(arg.providerOptions).toBeUndefined();
  });

  it("organização SEM chave nenhuma vira erro tipado, não uma falha genérica", async () => {
    chaveMock = () => null;

    await expect(embedText("oi", { organizationId: "org-1" })).rejects.toBeInstanceOf(
      SemChaveDeEmbeddingError,
    );
    // E não chega a chamar o SDK: falhar depois de gastar a chamada seria pior.
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("chave já resolvida NÃO é re-resolvida — indexar 200 trechos decifra a credencial uma vez", async () => {
    let resolucoes = 0;
    chaveMock = () => {
      resolucoes++;
      return {
        apiKey: "sk-x",
        baseUrl: null,
        viaGateway: false,
        origem: "credencial_da_organizacao",
        rotulo: "x",
        avisos: [],
      };
    };

    const chave = {
      apiKey: "sk-x",
      baseUrl: null,
      provedor: "openai" as const,
      viaGateway: false,
      origem: "credencial_da_organizacao" as const,
      rotulo: "x",
      avisos: [],
    };
    await embedText("a", { organizationId: "org-1", chave });
    await embedText("b", { organizationId: "org-1", chave });

    expect(resolucoes, "a chave passada por parâmetro foi ignorada e re-resolvida").toBe(0);
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });

  it("dimensão diferente do contrato é ERRO — recall quebrado em silêncio é pior", async () => {
    embedSpy.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 1 } });

    await expect(embedText("oi", { organizationId: "org-1" })).rejects.toThrow(/1536/);
  });

  describe("Tarefa 8: telemetria em llm_calls", () => {
    it("grava com cost_cents SEMPRE nulo, o ponto e os tokens do SDK", async () => {
      await embedText("oi", { organizationId: "org-1", ponto: "embedding_consultar" });

      expect(insertMock).toHaveBeenCalledTimes(1);
      const [tabela, row] = insertMock.mock.calls[0]!;
      expect(tabela).toBe("llm_calls");
      expect(row).toMatchObject({
        organization_id: "org-1",
        purpose: "embedding_consultar",
        provider: "openai",
        input_tokens: 7,
        cost_cents: null,
      });
    });

    it("D-053 item 3 e D-057: cada caminho da chave grava o provedor REAL e a origem no vocabulário de llm_calls", async () => {
      const casos = [
        {
          nome: "credencial da organização, direto na OpenAI",
          chave: { apiKey: "sk-org", baseUrl: null, provedor: "openai",
      viaGateway: false, origem: "credencial_da_organizacao" },
          provider: "openai",
          origem: "credencial_da_organizacao",
        },
        {
          nome: "binding do painel com endereço próprio",
          chave: { apiKey: "sk-b", baseUrl: "https://gateway.da-empresa.exemplo/v1", provedor: "openai",
      viaGateway: false, origem: "binding_do_ponto" },
          provider: "custom",
          origem: "credencial_da_organizacao",
        },
        {
          nome: "binding do painel sem endereço próprio",
          chave: { apiKey: "sk-b", baseUrl: null, provedor: "openai",
      viaGateway: false, origem: "binding_do_ponto" },
          provider: "openai",
          origem: "credencial_da_organizacao",
        },
        {
          nome: "chave da instalação, pela OpenRouter",
          chave: { apiKey: "sk-inst", baseUrl: "https://openrouter.ai/api/v1", provedor: "openrouter",
      viaGateway: false, origem: "chave_da_instalacao" },
          provider: "openrouter",
          origem: "chave_da_instalacao",
        },
      ] as const;

      for (const caso of casos) {
        insertMock.mockReset();
        chaveMock = () => ({ ...caso.chave, rotulo: null, avisos: [] });
        await embedText("oi", { organizationId: "org-1" });
        const row = insertMock.mock.calls[0]![1] as Record<string, unknown>;
        expect(row, caso.nome).toMatchObject({
          provider: caso.provider,
          origem_da_chave: caso.origem,
          model: "openai/text-embedding-3-small",
        });
        // O endereço nunca vai para a telemetria: pode levar credencial.
        expect(JSON.stringify(row), caso.nome).not.toContain("gateway.da-empresa");
      }
    });

    it("sem `ponto`, usa o padrão de indexar (mesmo default de resolverChaveDeEmbedding)", async () => {
      await embedText("a", { organizationId: "org-1" });

      const row = insertMock.mock.calls[0]![1] as Record<string, unknown>;
      expect(row.purpose).toBe("embedding_indexar");
    });

    it("o INSERT de telemetria lançando NÃO derruba o embedding: o resultado volta normal", async () => {
      insertDeveLancar = true;

      const r = await embedText("oi", { organizationId: "org-1" });

      expect(r.embedding).toHaveLength(1536);
      expect(r.promptTokens).toBe(7);
    });
  });
});

describe("embedTexts", () => {
  it("manda a lista inteira numa chamada e devolve um vetor por texto, na ordem", async () => {
    const r = await embedTexts(["a", "b", "c"], { organizationId: "org-1" });

    expect(embedManySpy).toHaveBeenCalledTimes(1);
    const arg = embedManySpy.mock.calls[0]?.[0] as { values: string[] };
    expect(arg.values).toEqual(["a", "b", "c"]);
    expect(r.embeddings).toHaveLength(3);
    expect(r.embeddings[0]).not.toEqual(r.embeddings[1]);
    expect(r.promptTokens).toBe(21);
  });

  it("lista vazia não chama o provedor, mas confere a chave e devolve o modelo", async () => {
    const r = await embedTexts([], { organizationId: "org-1" });

    expect(embedManySpy).not.toHaveBeenCalled();
    expect(r).toEqual({
      embeddings: [],
      promptTokens: 0,
      model: "openai/text-embedding-3-small",
    });
  });

  it("lista vazia com organização SEM chave ainda recusa", async () => {
    chaveMock = () => null;

    await expect(embedTexts([], { organizationId: "org-1" })).rejects.toBeInstanceOf(
      SemChaveDeEmbeddingError,
    );
  });

  // Estas duas são o motivo de a função existir em vez de um laço: em lote, um
  // vetor a menos ou fora de ordem gravaria o embedding de um trecho na linha
  // de outro, e o acervo responderia errado com nota alta.
  it("menos vetores que textos é ERRO — a ordem deixaria de casar", async () => {
    embedManySpy.mockResolvedValue({ embeddings: [vetor(0)], usage: { tokens: 1 } });

    await expect(embedTexts(["a", "b"], { organizationId: "org-1" })).rejects.toThrow(
      /1 vetores para 2 textos/,
    );
  });

  it("dimensão diferente do contrato é ERRO, em qualquer posição do lote", async () => {
    embedManySpy.mockResolvedValue({
      embeddings: [vetor(0), [0.1, 0.2]],
      usage: { tokens: 2 },
    });

    await expect(embedTexts(["a", "b"], { organizationId: "org-1" })).rejects.toThrow(/1536/);
  });

  it("a mesma régua de provedor do caminho de um texto: nunca a string com barra", async () => {
    await embedTexts(["a"], { organizationId: "org-1" });

    const arg = embedManySpy.mock.calls[0]?.[0] as { model: unknown };
    expect(typeof arg.model).not.toBe("string");
  });
});
