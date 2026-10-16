/**
 * O FREIO DE CUSTO NO SEAM — provado onde o modelo vira chamada: o argumento que
 * chega à FÁBRICA do registry e a linha de `llm_calls` (o que o plano debita).
 * Asserção sobre o retorno de `runModelCall` passaria mesmo com a fábrica errada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/credenciais/cifra", () => ({
  decifrarColunasDaCredencial: () => "chave-propria-da-empresa",
}));

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { _esquecerAvisosDeModelo } from "@/lib/ai/modelos-da-instalacao";

const ORG = "22222222-2222-4222-8222-222222222222";

function poolFalso(opts: { provider: string; defaultModel: string; byok?: boolean; lista?: string | null }) {
  const inserts: Array<{ params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          { llm: { provider: opts.provider, default_model: opts.defaultModel, params: {}, enabled_models: [] }, org_status: "active" },
        ],
      };
    }
    if (sql.includes("from platform_config")) {
      return { rows: opts.lista === undefined || opts.lista === null ? [] : [{ valor: opts.lista }] };
    }
    if (sql.includes("from ai_provider_credentials")) {
      return { rows: opts.byok ? [{ id: "cred-1", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }] : [] };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

function registrySpiao() {
  const chamadas: Array<{ provider: string; apiKey: string; modelId: string }> = [];
  const fabrica = (provider: string) => (apiKey: string, modelId: string) => {
    chamadas.push({ provider, apiKey, modelId });
    return {
      specificationVersion: "v3",
      provider,
      modelId,
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    } as never;
  };
  return {
    chamadas,
    registry: { anthropic: fabrica("anthropic"), openai: fabrica("openai"), openrouter: fabrica("openrouter") },
  };
}

const cfg = { openrouterApiKey: "chave-da-instalacao", openaiApiKey: "chave-openai-da-instalacao", cacheTtl: "1h" as const };

async function rodar(opts: Parameters<typeof poolFalso>[0]) {
  const { pool, inserts } = poolFalso(opts);
  const { registry, chamadas } = registrySpiao();
  const avisos: string[] = [];
  const log = { info: vi.fn(), error: vi.fn(), warn: (m: string) => void avisos.push(m) } as never;
  const chamar = () =>
    runModelCall(pool, cfg, { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] }, { registry, log });
  await chamar();
  return { chamadas, inserts, avisos, chamarDeNovo: chamar };
}

describe("o seam e a chave da instalação", () => {
  beforeEach(() => {
    _esquecerAvisosDeModelo();
    delete process.env.MODELOS_DA_INSTALACAO; // o setup de teste liga o `*`; aqui a lista vem do banco
  });

  it("modelo fora da lista na chave da instalação roda o padrão, e o log de custo leva o modelo efetivo", async () => {
    const { chamadas, inserts, avisos } = await rodar({ provider: "openrouter", defaultModel: "anthropic/claude-opus-5" });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({ provider: "openrouter", apiKey: "chave-da-instalacao", modelId: "openai/gpt-6-luna" });
    expect(inserts.some((i) => i.params.includes("openai/gpt-6-luna"))).toBe(true);
    expect(inserts.some((i) => i.params.includes("anthropic/claude-opus-5"))).toBe(false);
    expect(avisos.join(" ")).toContain("MODELOS_DA_INSTALACAO");
  });

  it("provedor direto recebe o padrão com o nome dele", async () => {
    const { chamadas } = await rodar({ provider: "openai", defaultModel: "gpt-5.6-terra" });
    expect(chamadas[0]).toMatchObject({ provider: "openai", apiKey: "chave-openai-da-instalacao", modelId: "gpt-6-luna" });
  });

  it("modelo que está na lista configurada pela tela passa inalterado", async () => {
    const { chamadas, avisos } = await rodar({
      provider: "openrouter",
      defaultModel: "anthropic/claude-haiku-4-5",
      lista: "openai/gpt-6-luna, anthropic/claude-haiku-4-5",
    });
    expect(chamadas[0]?.modelId).toBe("anthropic/claude-haiku-4-5");
    expect(avisos).toEqual([]);
  });

  it("o primeiro da lista configurada é o padrão que substitui", async () => {
    const { chamadas } = await rodar({ provider: "openrouter", defaultModel: "x/caro", lista: "google/gemini-flash,openai/gpt-6-luna" });
    expect(chamadas[0]?.modelId).toBe("google/gemini-flash");
  });

  it("`*` na lista desliga o freio", async () => {
    const { chamadas, avisos } = await rodar({ provider: "openrouter", defaultModel: "anthropic/claude-opus-5", lista: "*" });
    expect(chamadas[0]?.modelId).toBe("anthropic/claude-opus-5");
    expect(avisos).toEqual([]);
  });

  it("chave PRÓPRIA da empresa (BYOK): o modelo fica como está, mesmo fora da lista", async () => {
    const { chamadas, avisos } = await rodar({ provider: "openrouter", defaultModel: "anthropic/claude-opus-5", byok: true });
    expect(chamadas[0]).toMatchObject({ apiKey: "chave-propria-da-empresa", modelId: "anthropic/claude-opus-5" });
    expect(avisos).toEqual([]);
  });

  it("o aviso sai uma vez por organização e modelo, e o turno nunca falha", async () => {
    const r = await rodar({ provider: "openrouter", defaultModel: "anthropic/claude-opus-5" });
    await r.chamarDeNovo();
    expect(r.chamadas).toHaveLength(2);
    expect(r.chamadas.every((c) => c.modelId === "openai/gpt-6-luna")).toBe(true);
    expect(r.avisos.filter((a) => a.includes("MODELOS_DA_INSTALACAO"))).toHaveLength(1);
  });

  it("falha ao ler a configuração vale o padrão e o turno segue", async () => {
    const { pool } = poolFalso({ provider: "openrouter", defaultModel: "anthropic/claude-opus-5" });
    const original = (pool as unknown as { query: (sql: string, p?: unknown[]) => Promise<unknown> }).query;
    (pool as unknown as { query: unknown }).query = async (sql: string, p?: unknown[]) => {
      if (sql.includes("from platform_config")) throw new Error('relation "platform_config" does not exist');
      return original(sql, p);
    };
    const { registry, chamadas } = registrySpiao();
    await runModelCall(pool, cfg, { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] }, { registry });
    expect(chamadas[0]?.modelId).toBe("openai/gpt-6-luna");
  });
});
