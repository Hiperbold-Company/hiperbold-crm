/**
 * O FREIO DE CUSTO NOS WORKERS ANTIGOS (resposta automática, clima) — provado em
 * `resolverModeloDoPonto`, que devolve o modelo que vai ser chamado e o id que vai
 * para o log de custo. Chave da instalação + modelo fora de `MODELOS_DA_INSTALACAO`
 * → o padrão; chave própria da empresa → intacto; o ponto nunca fica mudo por isso.
 *
 * A configuração vem de `platform_config` pelo caminho real (`valorDaInstalacao`);
 * só o banco é dublê.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

const estado = vi.hoisted(() => ({
  credencial: null as Record<string, unknown> | null,
  /** O `valor` da linha MODELOS_DA_INSTALACAO em platform_config; null = sem linha. */
  lista: null as string | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (tabela === "platform_config") {
            return {
              data:
                estado.lista === null
                  ? null
                  : {
                      chave: "MODELOS_DA_INSTALACAO",
                      valor: estado.lista,
                      ciphertext: null,
                      iv: null,
                      tag: null,
                      last4: null,
                      eh_segredo: false,
                      semeado_do_env: false,
                    },
              error: null,
            };
          }
          if (tabela === "organizations") return { data: { settings: { llm: { provider: "openai" } } } };
          if (tabela === "ai_provider_credentials") return { data: estado.credencial };
          return { data: null };
        },
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "chave-decifrada-da-organizacao",
  byteaToBuffer: (v: unknown) => v,
}));

const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
const { _esquecerAvisosDeModelo } = await import("@/lib/ai/modelos-da-instalacao");

const ORG = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  delete process.env.MODELOS_DA_INSTALACAO; // o setup de teste liga o `*`; aqui a lista vem do banco
  estado.credencial = null;
  estado.lista = null;
  _esquecerAvisosDeModelo();
});

describe("chave da instalação", () => {
  it("modelo fora da lista roda o padrão (Luna), e o id do log é o efetivo", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or-instalacao";

    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");

    expect(r).not.toBeNull();
    expect(r?.origem).toBe("padrao");
    expect(r?.modelId).toBe("openai/gpt-6-luna");
    expect((r?.model as { modelId?: string }).modelId).toBe("openai/gpt-6-luna");
  });

  it("modelo na lista configurada passa inalterado", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or-instalacao";
    estado.lista = "openai/gpt-6-luna, anthropic/claude-haiku-4-5";

    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");

    expect(r?.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("o primeiro da lista configurada é o padrão", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or-instalacao";
    estado.lista = "google/gemini-flash,openai/gpt-6-luna";

    const r = await resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-opus-5");

    expect(r?.modelId).toBe("google/gemini-flash");
  });

  it("`*` desliga o freio", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or-instalacao";
    estado.lista = "*";

    const r = await resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-opus-5");

    expect(r?.modelId).toBe("anthropic/claude-opus-5");
  });

  it("id bare do catálogo que é o liberado passa (gpt-6-luna == openai/gpt-6-luna)", async () => {
    envMock.OPENAI_API_KEY = "sk-openai";

    const r = await resolverModeloDoPonto("bot_respond", ORG, "openai/gpt-6-luna");

    expect(r?.modelId).toBe("openai/gpt-6-luna");
  });

  it("se a instalação não sabe executar o padrão, o ponto segue com o pedido (nunca fica mudo)", async () => {
    envMock.ANTHROPIC_API_KEY = "sk-ant"; // sem rota para openai/gpt-6-luna

    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");

    expect(r).not.toBeNull();
    expect(r?.modelId).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("chave PRÓPRIA da empresa (BYOK)", () => {
  it("o modelo fica como está, mesmo fora da lista", async () => {
    estado.credencial = { provider: "openai", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };

    const r = await resolverModeloDoPonto("bot_respond", ORG, "openai/gpt-5.6-terra");

    expect(r?.origem).toBe("credencial_da_organizacao");
    expect(r?.modelId).toBe("openai/gpt-5.6-terra");
  });
});
