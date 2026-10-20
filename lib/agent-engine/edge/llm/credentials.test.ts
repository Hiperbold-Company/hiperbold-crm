import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-byok-da-org",
}));

import {
  llmEdgeConfigFromEnv,
  resolveOrgLlmConfig,
  LlmNotConfiguredError,
  type LlmEdgeConfig,
} from "./credentials";

/** Pool falso: 1ª query devolve settings->'llm', 2ª devolve credenciais BYOK. */
function poolFake(settingsLlm: unknown, credenciais: unknown[]) {
  let n = 0;
  return {
    query: async () => {
      n += 1;
      return n === 1 ? { rows: [{ llm: settingsLlm }] } : { rows: credenciais };
    },
  } as never;
}

const SEM_BYOK: unknown[] = [];

describe("resolveOrgLlmConfig — chave de plataforma por provider", () => {
  it("a chave da instalação é a da OpenRouter, mesmo quando o agente pede OpenAI e a OpenAI está no servidor", async () => {
    // Decisão do dono (20/10/2026): a chave da instalação sai SEMPRE pela OpenRouter. As chaves
    // diretas da OpenAI/Anthropic no servidor não entram na escada.
    const cfg: LlmEdgeConfig = {
      anthropicApiKey: "sk-ant-plataforma",
      openaiApiKey: "sk-proj-plataforma",
      openrouterApiKey: "sk-or-plataforma",
    };
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "anthropic", default_model: "claude-sonnet-4-6" }, SEM_BYOK),
      cfg,
      "org-1",
      { provider: "openai" },
    );
    expect(out.provider).toBe("openrouter");
    expect(out.providerPedido).toBe("openai");
    expect(out.apiKey).toBe("sk-or-plataforma");
  });

  it("só com a chave da Anthropic ou da OpenAI no servidor, a chave da instalação NÃO existe", async () => {
    for (const cfg of [{ anthropicApiKey: "sk-ant-plataforma" }, { openaiApiKey: "sk-proj-plataforma" }]) {
      await expect(
        resolveOrgLlmConfig(poolFake({ provider: "anthropic" }, SEM_BYOK), cfg, "org-1"),
      ).rejects.toBeInstanceOf(LlmNotConfiguredError);
    }
  });

  it("a credencial BYOK da org vence a do ambiente", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "openai", default_model: "gpt-4o" }, [
        { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" },
      ]),
      { openaiApiKey: "sk-proj-plataforma" },
      "org-1",
    );
    expect(out.apiKey).toBe("chave-byok-da-org");
  });

  it("sem BYOK e sem chave de plataforma, falha em vez de inventar", async () => {
    await expect(
      resolveOrgLlmConfig(poolFake({ provider: "openai" }, SEM_BYOK), {}, "org-1"),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});

/**
 * DE QUEM É A CHAVE — a pergunta que decide para onde ela pode ir.
 *
 * A decisão 22-a do dono do produto proíbe a chave da INSTALAÇÃO de acompanhar
 * um endereço que uma empresa escolheu. O seam do chat e o worker de mídia
 * recusam essa combinação lendo `origemDaChave`; se o resolvedor rotular errado
 * um degrau, a recusa falha aberta (chave sai) ou fechada (empresa com chave
 * própria para de funcionar). Cada degrau da escada é conferido aqui.
 */
describe("resolveOrgLlmConfig — a origem da chave acompanha o degrau", () => {
  it("credencial da organização → credencial_da_organizacao", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "openrouter", default_model: "x" }, [
        { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" },
      ]),
      { openrouterApiKey: "sk-or-plataforma" },
      "org-1",
    );
    expect(out.apiKey).toBe("chave-byok-da-org");
    expect(out.origemDaChave).toBe("credencial_da_organizacao");
  });

  it.each(["anthropic", "openai", "openrouter"] as const)(
    "sem credencial da org, pedindo %s, a chave da OpenRouter do .env → chave_da_instalacao",
    async (provider) => {
      const out = await resolveOrgLlmConfig(
        poolFake({ provider }, SEM_BYOK),
        { openrouterApiKey: "sk-or-plataforma" },
        "org-1",
      );
      expect(out.origemDaChave).toBe("chave_da_instalacao");
      expect(out.provider).toBe("openrouter");
    },
  );

  it("credencial ESCOLHIDA e revogada cai no .env — e o rótulo diz que a chave é da instalação", async () => {
    // O degrau menos óbvio: quem configurou escolheu uma credencial da empresa,
    // e por isso acredita que a chave é dela. A linha deixou de estar ativa, a
    // consulta volta vazia, e o resolvedor — que não lança por isso — entrega a
    // chave do .env.
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "openrouter" }, SEM_BYOK),
      { openrouterApiKey: "sk-or-plataforma" },
      "org-1",
      { provider: "openrouter", credentialId: "cred-revogada" },
    );
    expect(out.apiKey).toBe("sk-or-plataforma");
    expect(out.origemDaChave).toBe("chave_da_instalacao");
  });
});

/**
 * A ponte que faltava. Os testes acima provam que `resolveOrgLlmConfig` USA
 * `openaiApiKey` — e passavam. Só que nenhum caminho do agente PREENCHIA o campo:
 * `llmEdgeConfigFromEnv` montava apenas a chave da Anthropic, e o único lugar que
 * preenchia a da OpenAI era o worker de transcrição, na mão.
 *
 * Guardar a função de consumo não guarda o call site: a instalação tinha a chave
 * no `.env`, o teste do consumidor estava verde, e o agente OpenAI morria com
 * "org sem credencial LLM utilizável".
 */
describe("llmEdgeConfigFromEnv — o que sai do .env chega ao turno", () => {
  it("leva a chave da OpenAI, não só a da Anthropic", () => {
    const cfg = llmEdgeConfigFromEnv({
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_API_KEY: "sk-proj-y",
    });
    expect(cfg.anthropicApiKey).toBe("sk-ant-x");
    expect(cfg.openaiApiKey).toBe("sk-proj-y");
  });

  it("chave ausente continua ausente — string vazia não vira credencial", () => {
    const cfg = llmEdgeConfigFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "" });
    expect(cfg).not.toHaveProperty("openaiApiKey");
  });

  it("só OpenAI configurada: a config sai utilizável mesmo sem a Anthropic", () => {
    const cfg = llmEdgeConfigFromEnv({ OPENAI_API_KEY: "sk-proj-y" });
    expect(cfg).not.toHaveProperty("anthropicApiKey");
    expect(cfg.openaiApiKey).toBe("sk-proj-y");
  });

  it("o caminho inteiro: a OpenRouter do .env atende uma org sem BYOK que pede OpenAI — e a OPENAI_API_KEY do .env não", async () => {
    const cfg = llmEdgeConfigFromEnv({ OPENAI_API_KEY: "sk-proj-do-env", OPENROUTER_API_KEY: "sk-or-do-env" });
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "openai", default_model: "gpt-5-mini" }, SEM_BYOK),
      cfg,
      "org1",
    );
    expect(out.apiKey).toBe("sk-or-do-env");
    expect(out.provider).toBe("openrouter");
    // Só a OpenAI no .env: não há chave da instalação.
    await expect(
      resolveOrgLlmConfig(
        poolFake({ provider: "openai" }, SEM_BYOK),
        llmEdgeConfigFromEnv({ OPENAI_API_KEY: "sk-proj-do-env" }),
        "org1",
      ),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});
