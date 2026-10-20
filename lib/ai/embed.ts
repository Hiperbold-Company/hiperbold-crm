/**
 * Embedding do RAG — indexação e busca, o mesmo modelo dos dois lados.
 *
 * A chave vem de `lib/ai/embeddings/chave.ts`, que resolve pela organização:
 * binding do ponto → credencial OpenAI da org → chave da instalação (sempre
 * pela OpenRouter, `openai/text-embedding-3-small`, 1536 dimensões). Até a 0181 este arquivo lia SÓ `process.env`, e o efeito era o
 * pior possível para quem instala: cadastrar a chave da OpenAI pela tela não
 * habilitava a base de conhecimento, enquanto duas telas do produto prometiam
 * que sim.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { embed } from "ai";

import {
  DIMENSOES_DO_EMBEDDING,
  MODELO_DE_EMBEDDING,
  origemDaChaveParaLlmCalls,
  provedorDoEmbedding,
  resolverChaveDeEmbedding,
  type ChaveDeEmbedding,
  type PontoDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import type { ModelId } from "@/lib/ai/gateway";
import { registrarTelemetriaSemCusto } from "@/lib/ai/telemetria-sem-custo";
import { fetchParaDestinoDaOrganizacao } from "@/lib/automation/destinos-internos-autorizados";
import { logger } from "@/lib/logger";

export interface EmbedOptions {
  organizationId: string;
  /**
   * Qual ponto de IA está chamando. Muda apenas de QUAL binding a chave sai —
   * o modelo é o mesmo por contrato, e divergir quebraria o recall em silêncio.
   */
  ponto?: PontoDeEmbedding;
  /**
   * Chave já resolvida. Existe para o indexador resolver UMA vez e embedar N
   * chunks: sem isto, indexar um documento de 200 trechos decifraria a
   * credencial 200 vezes.
   */
  chave?: ChaveDeEmbedding;
  model?: ModelId;
}

export interface EmbedResult {
  embedding: number[];
  promptTokens: number;
  model: string;
}

/** Falta de chave é um ESTADO do tenant, não um acidente: tipo próprio para quem
 *  chama poder mostrar a tela certa em vez de repetir um erro genérico. */
export class SemChaveDeEmbeddingError extends Error {
  readonly code = "embedding_sem_chave";
  constructor(readonly organizationId: string) {
    super(
      "Esta organização não tem chave da OpenAI para indexar nem consultar o material. " +
        "Cadastre uma em Credenciais, ou defina OPENROUTER_API_KEY na instalação.",
    );
    this.name = "SemChaveDeEmbeddingError";
  }
}

/**
 * O status HTTP de um erro do AI SDK (`APICallError.statusCode`), ou `null` quando não houve resposta
 * (rede). O `embed` repete a chamada em erro repetível (429, 5xx, rede) e, esgotadas as tentativas,
 * lança um `RetryError` cujo status mora em `lastError`: sem desembrulhar, um 429 pareceria "sem
 * resposta" e acionaria o plano B por engano.
 */
function statusDoErro(erro: unknown): number | null {
  const e = erro as
    | { statusCode?: unknown; status?: unknown; lastError?: unknown }
    | null
    | undefined;
  const status = e?.statusCode ?? e?.status;
  if (typeof status === "number") return status;
  if (e?.lastError !== undefined && e.lastError !== erro) return statusDoErro(e.lastError);
  return null;
}

/** Plano B só para o que a OpenRouter não conseguiu responder: sem resposta (rede) ou 5xx. */
function falhaDeDisponibilidade(erro: unknown): boolean {
  const status = statusDoErro(erro);
  return status === null || status >= 500;
}

export async function embedText(
  content: string,
  opts: EmbedOptions,
): Promise<EmbedResult> {
  const chave =
    opts.chave ?? (await resolverChaveDeEmbedding(opts.organizationId, opts.ponto));
  if (!chave) {
    throw new SemChaveDeEmbeddingError(opts.organizationId);
  }

  const modelId = String(opts.model ?? MODELO_DE_EMBEDDING);

  // Chave da INSTALAÇÃO: pela OpenRouter (`/embeddings`), que só entende o id com fabricante
  // (`openai/text-embedding-3-small`). O endereço vem do `.env` da instalação, nunca de uma
  // empresa, então não passa pela régua de destino de organização.
  //
  // Chave da ORGANIZAÇÃO: precisa ser o provider OpenAI EXPLÍCITO. Passar a string com barra
  // aqui não cai no OpenAI direto — no AI SDK, id com barra é resolvido pelo gateway da Vercel
  // mesmo sem chave, entrando no plano anônimo, cujo teto devolve `GatewayRateLimitError` e
  // derruba a busca na base de conhecimento.
  const resolvido = chave.viaOpenRouter
    ? createOpenAI({
        apiKey: chave.apiKey,
        ...(chave.baseUrl ? { baseURL: chave.baseUrl } : {}),
      }).textEmbeddingModel(modelId.includes("/") ? modelId : `openai/${modelId}`)
    : createOpenAI({
        apiKey: chave.apiKey,
        // O endereço só existe aqui quando veio do binding da ORGANIZAÇÃO, e
        // quem chama é o servidor, com a chave da empresa no
        // cabeçalho: cada requisição passa pela régua de destino da
        // organização antes de sair (decisão 22-d), senão o admin de uma
        // empresa apontaria o embedding para o metadata da nuvem ou para um
        // serviço interno do compose.
        ...(chave.baseUrl
          ? { baseURL: chave.baseUrl, fetch: fetchParaDestinoDaOrganizacao() }
          : {}),
      }).textEmbeddingModel(modelId.replace(/^openai\//, ""));

  // PLANO B (decisão do dono, 20/10/2026): se a OpenRouter ficar INDISPONÍVEL (erro de rede ou 5xx)
  // e o servidor tiver `OPENAI_API_KEY`, tenta a OpenAI direto UMA vez e deixa o rastro no log, em
  // nível error (é um desvio do caminho contratado que alguém da plataforma precisa ver). Qualquer
  // 4xx NÃO conta: 401/403 é chave recusada, 402 é saldo, 429 é limite — defeito de configuração ou
  // de conta que precisa aparecer, e não pode ser mascarado pela outra chave. Só a chave da
  // INSTALAÇÃO tem plano B: a credencial da empresa nunca é trocada por outra.
  let usouPlanoB = false;
  let result: Awaited<ReturnType<typeof embed>>;
  try {
    result = await embed({ model: resolvido, value: content });
  } catch (erro) {
    const chaveOpenAi = (process.env.OPENAI_API_KEY ?? "").trim();
    if (!chave.viaOpenRouter || chaveOpenAi === "" || !falhaDeDisponibilidade(erro)) throw erro;
    logger.error("[embedding] OpenRouter indisponível — usando a OpenAI direto, uma vez (plano B)", {
      organization_id: opts.organizationId,
      ponto: opts.ponto ?? "embedding_indexar",
      status: statusDoErro(erro) ?? "sem_status",
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    usouPlanoB = true;
    result = await embed({
      model: createOpenAI({ apiKey: chaveOpenAi }).textEmbeddingModel(modelId.replace(/^openai\//, "")),
      value: content,
    });
  }

  // Dimensão asserida a cada chamada: divergir de modelo quebra o recall em
  // SILÊNCIO (os vetores deixam de ser comparáveis), e uma chamada recusada é
  // infinitamente melhor que um acervo que responde errado com nota alta.
  if (result.embedding.length !== DIMENSOES_DO_EMBEDDING) {
    throw new Error(
      `embedding com ${result.embedding.length} dimensões, esperado ${DIMENSOES_DO_EMBEDDING} ` +
        `(pin de contrato ${modelId}) — recall quebraria em silêncio`,
    );
  }

  // EmbedResult.embedding is `number[]` for single-value embed.
  const promptTokens =
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.tokens ??
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.promptTokens ??
    0;

  // Telemetria (Tarefa 8, Frente 2 dos planos): este é o ÚNICO lugar que sabe
  // o modelo e os tokens reais da chamada de embedding. Os chamadores
  // (`searchKnowledge`, `rag-indexer`, `ai-response-worker`) só sabem o texto
  // e a organização. `opts.ponto` distingue indexar de consultar; sem ele
  // (caso do indexador, que resolve a chave uma vez fora do loop) vale o
  // mesmo padrão de `resolverChaveDeEmbedding`. Nunca lança, ver
  // `registrarTelemetriaSemCusto`.
  await registrarTelemetriaSemCusto({
    organizationId: opts.organizationId,
    purpose: opts.ponto ?? "embedding_indexar",
    // O provedor REAL da chamada (D-053 item 3): OpenRouter (chave da instalação), endereço
    // próprio ou OpenAI direto (credencial da organização). Era "openai" fixo, e a divisão de
    // custo por provedor atribuía à OpenAI o que saía por outro caminho.
    provider: usouPlanoB ? "openai" : provedorDoEmbedding(chave),
    // O MODELO do embedding é a mesma OpenAI por contrato em qualquer caminho,
    // então o preço vem do catálogo dela (`openai` + `text-embedding-3-small`),
    // e não de uma linha "openrouter"/"custom" que o catálogo não tem.
    providerParaPreco: "openai",
    model: modelId,
    inputTokens: promptTokens,
    // D-057: de quem é a chave, no vocabulário de `llm_calls`. Peso 0 na carteira
    // hoje, mas a origem fica gravada e certa para o dia em que o peso mudar.
    origemDaChave: origemDaChaveParaLlmCalls(chave.origem),
  });

  return { embedding: result.embedding, promptTokens, model: modelId };
}
