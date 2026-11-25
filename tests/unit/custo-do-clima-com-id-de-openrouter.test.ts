import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CLIMA (`sentiment_classify`) PELO MODELO DA INSTALAÇÃO COBRAVA ~100× O REAL.
 *
 * Medido na produção (llm_calls, 30 dias até 25/11/2026), mesmo modelo
 * `openai/gpt-6-luna`: `agent_turn` e `promise_semantic` saíam no preço da
 * tabela, e o `sentiment_classify` de uma organização somava US$ 1,63 para
 * 51.069 tokens de entrada e 11.933 de saída — pelo preço do Luna (10/50
 * centavos por milhão), uns US$ 0,011. Nenhuma tarifa única explica as duas
 * organizações medidas ao mesmo tempo: o excesso é POR CHAMADA, e é o
 * `Math.ceil` ao centavo inteiro que `computeCost` fazia até a junção do
 * upstream (PR #32, na `main` em 05/11/2026). Um classificador de ~300 tokens
 * custa ~0,007 centavo; o ceil gravava 1.
 *
 * `custo-de-ia-nao-arredonda-para-cima.test.ts` já fixa o fracionário, mas só
 * pelo id SEM prefixo, que `ai_pricing` conhece. O id que a produção grava é o
 * da chave da instalação, `openai/gpt-6-luna`: ele erra o `ai_pricing` e é
 * precificado pelo CATÁLOGO (`ai_models`). Este arquivo fixa o caminho real.
 */

const AI_PRICING = [
  {
    model: "gpt-6-luna",
    prompt_cents_per_million_tokens: "10.0000",
    completion_cents_per_million_tokens: "50.0000",
    embedding_cents_per_million_tokens: null,
  },
];

const AI_MODELS = [
  {
    provider: "openai",
    model_id: "gpt-6-luna",
    input_price_per_million_cents: 10,
    output_price_per_million_cents: 50,
    deprecated_at: null,
  },
];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const linhas = tabela === "ai_pricing" ? AI_PRICING : tabela === "ai_models" ? AI_MODELS : [];
        const resposta = { data: linhas, error: null };
        // `ai_pricing` encadeia `.is("superseded_at", null)`; `ai_models` é
        // aguardado direto. O mesmo objeto atende os dois.
        return Object.assign(Promise.resolve(resposta), { is: async () => resposta });
      },
    }),
  }),
}));

import { _resetPricingCacheForTests, computeCost } from "@/lib/ai/cost";
import { _resetRuntimeCostCacheForTests } from "@/lib/ai/runtime/cost";

beforeEach(() => {
  _resetPricingCacheForTests();
  _resetRuntimeCostCacheForTests();
});

describe("computeCost — o id com prefixo da chave da instalação", () => {
  it("uma chamada do clima custa o preço do Luna, não 1 centavo", async () => {
    // A média da produção: 51.069 / 163 chamadas ≈ 313 de entrada, 73 de saída.
    const cents = await computeCost({ model: "openai/gpt-6-luna", promptTokens: 313, completionTokens: 73 });
    expect(cents).toBeCloseTo((313 * 10 + 73 * 50) / 1_000_000, 10);
    expect(cents, "voltou o centavo inteiro por chamada").toBeLessThan(0.01);
  });

  it("o mês medido na produção soma o que o Luna cobra, não US$ 1,63", async () => {
    // 163 chamadas que somam os tokens da organização A.
    let total = 0;
    for (let i = 0; i < 163; i++) {
      const c = await computeCost({
        model: "openai/gpt-6-luna",
        promptTokens: i < 50 ? 314 : 313,
        completionTokens: i < 34 ? 74 : 73,
      });
      if (c === null) throw new Error("openai/gpt-6-luna sem preço");
      total += c;
    }
    // Real: (51.069×10 + 11.933×50)/1M ≈ 1,107 centavo. Com o ceil eram 163.
    expect(total).toBeCloseTo((51_069 * 10 + 11_933 * 50) / 1_000_000, 6);
    expect(total).toBeLessThan(2);
  });
});
