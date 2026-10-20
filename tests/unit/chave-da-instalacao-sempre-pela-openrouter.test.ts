/**
 * A CHAVE DA INSTALAÇÃO SAI SEMPRE PELA OPENROUTER (decisão do dono, 20/10/2026).
 *
 * Medido em produção: o servidor tinha `OPENROUTER_API_KEY`, `OPENAI_API_KEY` e nenhuma chave da
 * Anthropic, e `llm_calls` mostrava `provider = openai`, `model = openai/gpt-6-luna`,
 * `origem_da_chave = chave_da_instalacao`: o Luna ia DIRETO à OpenAI. Estes testes provam o
 * comportamento, não a implementação: o resolvedor real roda contra um banco falso e as chaves
 * presentes no servidor decidem para onde a chamada vai.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-da-propria-empresa",
}));

import {
  LlmNotConfiguredError,
  resolveOrgLlmConfig,
  type LlmEdgeConfig,
} from "@/lib/agent-engine/edge/llm/credentials";
import {
  ehVarianteEmLote,
  idNaRotaDaInstalacao,
  modelosParaOSeletor,
  PROVEDOR_DA_CHAVE_DA_INSTALACAO,
} from "@/lib/ai/modelos-da-instalacao";
import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { lerAmbiente } from "@/lib/instalacao/ambiente";

/** Banco falso: 1ª consulta devolve `settings.llm`, 2ª as credenciais da organização. */
function pool(settingsLlm: unknown, credenciais: unknown[] = []) {
  let n = 0;
  return {
    query: async () => {
      n += 1;
      return n === 1 ? { rows: [{ llm: settingsLlm }] } : { rows: credenciais };
    },
  } as never;
}

const TODAS_AS_CHAVES: LlmEdgeConfig = {
  openrouterApiKey: "sk-or-instalacao",
  openaiApiKey: "sk-openai-do-servidor",
  anthropicApiKey: "sk-ant-do-servidor",
};

describe("resolveOrgLlmConfig — a chave da instalação", () => {
  it.each(["openai", "anthropic", "openrouter"])(
    "pedido ao %s sem chave própria: sai pela OpenRouter, mesmo com OpenAI e Anthropic no servidor",
    async (provedor) => {
      const out = await resolveOrgLlmConfig(
        pool({ provider: provedor, default_model: "openai/gpt-6-luna" }),
        TODAS_AS_CHAVES,
        "org-1",
      );
      expect(out.provider).toBe(PROVEDOR_DA_CHAVE_DA_INSTALACAO);
      expect(out.apiKey).toBe("sk-or-instalacao");
      expect(out.origemDaChave).toBe("chave_da_instalacao");
      expect(out.providerPedido).toBe(provedor);
    },
  );

  it("o override do agente (provider openai) também cai na OpenRouter", async () => {
    const out = await resolveOrgLlmConfig(pool({ provider: "anthropic" }), TODAS_AS_CHAVES, "org-1", {
      provider: "openai",
    });
    expect(out.provider).toBe("openrouter");
    expect(out.apiKey).toBe("sk-or-instalacao");
  });

  it("sem OPENROUTER_API_KEY falha com o erro de 'sem chave' — não cai para OpenAI nem Anthropic", async () => {
    await expect(
      resolveOrgLlmConfig(
        pool({ provider: "openai" }),
        { openaiApiKey: "sk-openai-do-servidor", anthropicApiKey: "sk-ant-do-servidor" },
        "org-1",
      ),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("credencial PRÓPRIA da organização continua valendo, no provedor que ela escolheu", async () => {
    const out = await resolveOrgLlmConfig(
      pool({ provider: "openai", default_model: "gpt-4o" }, [
        { id: "c1", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" },
      ]),
      TODAS_AS_CHAVES,
      "org-1",
    );
    expect(out.provider).toBe("openai");
    expect(out.apiKey).toBe("chave-da-propria-empresa");
    expect(out.origemDaChave).toBe("credencial_da_organizacao");
  });

  it("provedor sem chave de plataforma (google) segue falhando: a instalação não o atende", async () => {
    await expect(
      resolveOrgLlmConfig(pool({ provider: "google" }), TODAS_AS_CHAVES, "org-1"),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});

describe("id do modelo na rota da instalação", () => {
  it("id puro do catálogo ganha o fabricante do provedor pedido; id com fabricante passa intacto", () => {
    expect(idNaRotaDaInstalacao("anthropic", "claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(idNaRotaDaInstalacao("openai", "gpt-6-luna")).toBe("openai/gpt-6-luna");
    expect(idNaRotaDaInstalacao("anthropic", "openai/gpt-6-luna")).toBe("openai/gpt-6-luna");
    expect(idNaRotaDaInstalacao("openrouter", "openai/gpt-6-luna")).toBe("openai/gpt-6-luna");
  });
});

describe("chave de plataforma vista pelas telas e pela publicação", () => {
  it("com só OPENROUTER_API_KEY, os três provedores da instalação têm chave; sem ela, nenhum", () => {
    const com = lerAmbiente({ OPENROUTER_API_KEY: "sk-or" });
    expect(com.chavesDeProvedor).toMatchObject({ anthropic: true, openai: true, openrouter: true });
    const sem = lerAmbiente({ OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-ant" });
    expect(sem.chavesDeProvedor).toMatchObject({ anthropic: false, openai: false, openrouter: false });
  });

  it("chaveDePlataforma devolve a da OpenRouter para os três e nunca a da OpenAI/Anthropic", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-instalacao");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    expect(chaveDePlataforma("openai")).toBe("sk-or-instalacao");
    expect(chaveDePlataforma("anthropic")).toBe("sk-or-instalacao");
    expect(chaveDePlataforma("google")).toBeNull();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(chaveDePlataforma("openai")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("lista de modelos de quem usa a chave da instalação", () => {
  const catalogoDaAnthropic = [
    { model_id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
    { model_id: "claude-opus-5", display_name: "Claude Opus 5" },
  ];

  it("mostra SÓ os liberados (Luna), qualquer que seja o provedor escolhido — sem Claude", () => {
    for (const provedor of ["anthropic", "openai", "openrouter"]) {
      const opcoes = modelosParaOSeletor({
        catalogo: catalogoDaAnthropic,
        liberados: ["openai/gpt-6-luna"],
        provedor,
        restrito: true,
      });
      expect(opcoes.map((o) => o.model_id)).toEqual(["openai/gpt-6-luna"]);
    }
  });

  it("com chave própria o catálogo inteiro segue disponível", () => {
    const opcoes = modelosParaOSeletor({
      catalogo: catalogoDaAnthropic,
      liberados: ["openai/gpt-6-luna"],
      provedor: "anthropic",
      restrito: false,
    });
    expect(opcoes).toHaveLength(2);
  });
});

describe("variante em lote da OpenRouter", () => {
  it("`:batch` é reconhecida (assíncrona, nunca atende conversa); o modelo normal não", () => {
    expect(ehVarianteEmLote("openai/gpt-6-luna:batch")).toBe(true);
    expect(ehVarianteEmLote("openai/gpt-6-luna-pro:BATCH")).toBe(true);
    expect(ehVarianteEmLote("openai/gpt-6-luna")).toBe(false);
  });
});
