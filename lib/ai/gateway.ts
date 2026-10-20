/**
 * Roteamento de modelo da chave da INSTALAÇÃO.
 *
 * Centralises model routing so the rest of the codebase only references model
 * strings like `"openai/gpt-6-luna"`. A chave da instalação sai sempre pela
 * OpenRouter (`OPENROUTER_API_KEY`). Lazy initialisation: if it is missing we
 * deliberately do NOT throw at import time — `resolveLanguageModel()` returns
 * null and callers skip gracefully.
 *
 * Anti-pattern guard (CLAUDE.md): we never `import Anthropic from "@anthropic-ai/sdk"`.
 * Only model strings via the gateway-shaped `ai` SDK calls.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import { env } from "@/lib/env";

/** Endpoint da OpenRouter. Compatível com a API da OpenAI, então o provider
 *  `@ai-sdk/openai` fala com ela sem dependência nova. */
export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1";

export type ModelId =
  | "anthropic/claude-sonnet-5"
  | "anthropic/claude-opus-5"
  | "anthropic/claude-haiku-4-5"
  | "openai/text-embedding-3-small"
  // Allow arbitrary tenant-configured strings without losing autocomplete on the canonical ones.
  | (string & {});

export const DEFAULT_BOT_MODEL: ModelId = "anthropic/claude-sonnet-5";
export const DEFAULT_CLASSIFIER_MODEL: ModelId = "anthropic/claude-haiku-4-5";
export const DEFAULT_EMBEDDING_MODEL: ModelId = "openai/text-embedding-3-small";

/**
 * Resolve o modelo de CHAT para algo que o `ai` SDK saiba executar.
 *
 * Existe porque a checagem de "tem IA" e a execução real estavam
 * desalinhados: a checagem dizia "tem IA" com a `ANTHROPIC_API_KEY` (a única
 * que o install.sh exige), mas quem executava passava o id como STRING, e no
 * AI SDK string com barra é roteada pelo gateway da Vercel — que sem
 * `AI_GATEWAY_API_KEY` cai no plano anônimo e devolve
 *
 *     Unauthenticated. Configure AI_GATEWAY_API_KEY or use a provider module.
 *
 * Ou seja: em TODA instalação self-host padrão o worker de sentimento falhava
 * em loop. Mesma armadilha que o `embed.ts` já documentava e resolvia para
 * embeddings; aqui o caminho de chat ficou sem o equivalente.
 *
 * A chave da INSTALAÇÃO sai SEMPRE pela OpenRouter (`OPENROUTER_API_KEY`), decisão do dono do
 * produto em 20/10/2026: é a que paga a conta de todas as empresas e debita os tokens do plano.
 * Os ids da OpenRouter já são `fabricante/modelo`, então o mesmo id canônico serve sem tradução.
 * Nem o gateway da Vercel nem a Anthropic/OpenAI direto entram aqui, mesmo com as chaves no
 * servidor — é a rota que o relatório de custo e a carteira de tokens medem.
 *
 * Devolve null quando não há `OPENROUTER_API_KEY`, para o chamador PULAR com motivo claro (ou
 * falhar com o erro de "sem chave") em vez de cair para outro provedor ou estourar com erro de
 * rede lá dentro.
 */
export function resolveLanguageModel(model: ModelId): LanguageModel | null {
  const id = String(model);

  if (env.OPENROUTER_API_KEY) {
    return createOpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
    }).chat(id); // chat/completions, como o registry do worker (providers.ts)
  }

  return null;
}

export function isEmbeddingProviderConfigured(): boolean {
  // Embeddings da instalação saem pela OpenRouter, como o resto (ver `lib/ai/embeddings/chave.ts`).
  return Boolean(env.OPENROUTER_API_KEY);
}

/**
 * The `ai` SDK uses `AI_GATEWAY_API_KEY` from process.env automatically when
 * passing string model ids. We surface it here so the worker can fail fast
 * with a clear skip reason, and so future explicit `createGateway()` callers
 * have the canonical place to read config.
 */
export function gatewayConfig(): { apiKey: string; baseURL?: string } | null {
  if (!env.AI_GATEWAY_API_KEY) return null;
  return {
    apiKey: env.AI_GATEWAY_API_KEY,
    baseURL: env.AI_GATEWAY_BASE_URL || undefined,
  };
}
