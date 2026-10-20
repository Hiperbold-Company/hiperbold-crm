/**
 * O que este teste protege: **o modelo de CHAT tem que virar um provider
 * explícito quando não há gateway.**
 *
 * `isAiGatewayConfigured()` já devolvia `true` com só `ANTHROPIC_API_KEY` — a
 * única chave que o `install.sh` exige. Mas quem executava passava o id como
 * STRING, e no AI SDK id com barra é resolvido pelo **gateway da Vercel mesmo
 * sem chave**, caindo no plano anônimo:
 *
 *     Unauthenticated. Configure AI_GATEWAY_API_KEY or use a provider module.
 *
 * Resultado observado numa instalação self-host real: o `ai-sentiment-worker`
 * falhava em loop, uma vez por mensagem recebida. Ou seja, a checagem dizia
 * "tem IA" e a execução dizia "não tem" — desalinhados.
 *
 * A asserção é sobre o TIPO do retorno, mesma lógica do `embed.test.ts`:
 * string = "deixa o gateway resolver"; objeto = "provider explícito". É a única
 * diferença observável sem rede.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

import { resolveLanguageModel } from "@/lib/ai/gateway";

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
});

describe("resolveLanguageModel — a chave da instalação sai SEMPRE pela OpenRouter", () => {
  it("com OPENROUTER_API_KEY devolve provider explícito (nunca string que o gateway da Vercel roteie)", () => {
    envMock.OPENROUTER_API_KEY = "sk-or-xxx";
    const model = resolveLanguageModel("openai/gpt-6-luna");
    expect(model).not.toBeNull();
    expect(typeof model).not.toBe("string");
  });

  it("o gateway da Vercel NÃO tem mais precedência: com as duas chaves, vale a OpenRouter", () => {
    envMock.AI_GATEWAY_API_KEY = "gw-key";
    envMock.OPENROUTER_API_KEY = "sk-or-xxx";
    expect(typeof resolveLanguageModel("anthropic/claude-haiku-4-5")).not.toBe("string");
  });

  it("OpenAI e Anthropic no servidor NÃO atendem a chave da instalação: sem OpenRouter devolve null", () => {
    envMock.OPENAI_API_KEY = "sk-openai";
    envMock.ANTHROPIC_API_KEY = "sk-ant-xxx";
    envMock.AI_GATEWAY_API_KEY = "gw-key";
    expect(resolveLanguageModel("openai/gpt-6-luna")).toBeNull();
    expect(resolveLanguageModel("anthropic/claude-haiku-4-5")).toBeNull();
  });

  it("sem chave nenhuma devolve null, para o chamador PULAR com motivo claro", () => {
    expect(resolveLanguageModel("openai/gpt-6-luna")).toBeNull();
  });
});
