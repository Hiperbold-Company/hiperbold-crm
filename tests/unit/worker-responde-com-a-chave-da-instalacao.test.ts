/**
 * A CHAVE DA INSTALAÇÃO ATENDE O WORKER — e ela é SEMPRE a OpenRouter (decisão do dono, 20/10/2026).
 *
 * Histórico (issue #1181): a instalação com só `OPENAI_API_KEY` não respondia, porque o id BARE do
 * catálogo não achava rota. Hoje a chave da instalação é só `OPENROUTER_API_KEY`: o id bare ganha o
 * fabricante pelo catálogo, o freio de custo troca o que não é liberado pelo Luna, e OpenAI/Anthropic
 * no servidor NÃO atendem este caminho.
 *
 * Texto original do teste:
 *
 * A CHAVE DA INSTALAÇÃO ATENDE O WORKER — inclusive quando só há `OPENAI_API_KEY`.
 *
 * O `install.sh` oferece OpenAI como provedor e a chave vai para
 * `OPENAI_API_KEY`; o catálogo (`ai_models`, migration 0104) serve o id do
 * modelo BARE (`gpt-5.6-terra`, o `is_default_for_provider` da OpenAI), sem
 * prefixo de rota; e o turno real monta o provedor pelo par (provider da
 * organização, chave do ambiente) em `buildModel`. É por isso que o ensaio do
 * agente e o "Sugerir resposta" respondem numa instalação assim.
 *
 * O worker de resposta automática não respondia. Ele resolvia o modelo por
 * `resolveLanguageModel`, que roteia pelo PREFIXO do id canônico
 * (`openai/gpt-5.6-terra`): id sem prefixo não acha provedor nenhum, o resolver
 * devolvia `null` e a mensagem do cliente era pulada com
 * `reason: "ai_gateway_key_missing"` — com a chave certa no `.env` (issue
 * #1181).
 *
 * O que este teste prende: com só `OPENAI_API_KEY`, o id do catálogo resolve no
 * provedor que a ORGANIZAÇÃO escolheu; o id que chega ao SDK é o do catálogo,
 * sem a rota (o prefixo é rota, não nome de modelo); sem chave nenhuma o
 * desfecho continua o mesmo; e id de outro provedor não passa a ser atendido
 * pela chave da OpenAI.
 *
 * E os DOIS CAMINHOS da escada de chave, medidos separadamente: quando a conta
 * TEM credencial utilizável quem responde é ela (`credencial_da_organizacao`);
 * quando a conta NÃO tem, quem responde é a chave da plataforma
 * (`padrao`) — inclusive quando o provedor que a organização registrou não tem
 * chave no ambiente, caso em que quem decide de quem é o id BARE é o catálogo
 * `ai_models` e não uma tentativa com qualquer chave que exista.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

const estado = vi.hoisted(() => ({
  binding: null as Record<string, unknown> | null,
  credencial: null as Record<string, unknown> | null,
  settings: null as unknown,
  /** Linha do catálogo `ai_models` para o id BARE que o teste usa. */
  catalogo: null as Record<string, unknown> | null,
  leiturasDeOrganizacao: 0,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "organizations") estado.leiturasDeOrganizacao += 1;
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          data:
            tabela === "ai_purpose_bindings"
              ? estado.binding
              : tabela === "organizations"
                ? { settings: estado.settings }
                : tabela === "ai_models"
                  ? estado.catalogo
                  : estado.credencial,
        }),
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

const ORG = "33333333-3333-4333-8333-333333333333";
const MODELO_PADRAO_DA_OPENAI = "gpt-5.6-terra";

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  estado.binding = null;
  estado.credencial = null;
  estado.settings = { llm: { provider: "openai" } };
  estado.catalogo = { provider: "openai" };
  estado.leiturasDeOrganizacao = 0;
});

const LUNA = "openai/gpt-6-luna";
/** O id bare do catálogo, escrito com o fabricante que o catálogo lhe dá — o que a OpenRouter entende. */
const TERRA_NA_ROTA = "openai/gpt-5.6-terra";
// O setup dos testes liga o freio em `*` (libera todos os modelos): a troca pelo Luna é provada em
// `modelos-da-instalacao-no-gateway.test.ts`. Aqui o que se prova é a ROTA: sempre OpenRouter.

describe("o worker responde com a chave da instalação (sempre a OpenRouter)", () => {
  it("só com OPENROUTER_API_KEY, o id bare do catálogo resolve o ponto, escrito com o fabricante", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or";

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.modelId).toBe(TERRA_NA_ROTA);
    expect(resolvido?.origem).toBe("padrao");
  });

  it("o id que chega à OpenRouter leva o fabricante (ela não entende id bare)", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or";

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);
    const instanciado = resolvido?.model as { modelId?: string; provider?: string } | undefined;

    expect(typeof resolvido?.model).toBe("object");
    expect(instanciado?.modelId).toBe(TERRA_NA_ROTA);
    expect(instanciado?.provider).toMatch(/openai/); // o SDK OpenAI-compatível apontado à OpenRouter
  });

  it("binding sem credencial utilizável também cai na chave da instalação", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or";
    estado.binding = {
      provider: "openai",
      credential_id: null,
      model_id: MODELO_PADRAO_DA_OPENAI,
      base_url: null,
    };

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.origem).toBe("padrao");
  });

  it("sem chave nenhuma no ambiente o desfecho continua o mesmo", async () => {
    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).toBeNull();
  });

  it.each([["OPENAI_API_KEY"], ["ANTHROPIC_API_KEY"], ["AI_GATEWAY_API_KEY"]])(
    "só com %s no servidor, a chave da instalação NÃO atende: o ponto pula (nunca vai direto ao fabricante)",
    async (variavel) => {
      envMock[variavel] = "sk-qualquer";

      expect(await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI)).toBeNull();
      expect(await resolverModeloDoPonto("bot_respond", ORG, LUNA)).toBeNull();
    },
  );

  it("modelo de outro fabricante também sai pela OpenRouter (nunca direto na Anthropic)", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or";

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-haiku-4-5");

    expect(resolvido?.modelId).toBe("anthropic/claude-haiku-4-5");
    expect((resolvido?.model as { provider?: string }).provider).toMatch(/openai/); // SDK OpenAI-compatível
  });

  it("id canônico liberado segue resolvendo, sem trocar", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or";

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, LUNA);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.modelId).toBe(LUNA);
  });

  it("id prefixado não paga a leitura do provedor da organização", async () => {
    // O caminho da instalação padrão roda a cada evento do worker de sentimento. A única leitura de
    // `organizations` que lhe cabe é a da procura por credencial; a do provedor só serve a id BARE.
    envMock.OPENROUTER_API_KEY = "sk-or";

    const resolvido = await resolverModeloDoPonto("sentiment_classify", ORG, LUNA);

    expect(resolvido).not.toBeNull();
    expect(estado.leiturasDeOrganizacao).toBe(1);
  });

  it("caminho 1 — a chave da CONTA responde, sem chave nenhuma no ambiente", async () => {
    // Sem chave de instalação de propósito: quem paga é a credencial que a organização cadastrou e
    // validou em IA › Credenciais (e ela é direta no provedor dela).
    estado.settings = { llm: { provider: "openai" } };
    estado.credencial = { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.origem).toBe("credencial_da_organizacao");
    expect(resolvido?.modelId).toBe(MODELO_PADRAO_DA_OPENAI);
  });

  it("caminho 2 — sem chave na conta, quem responde é a chave da PLATAFORMA (OpenRouter)", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or";
    estado.settings = { llm: { provider: "openai" } };

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.origem).toBe("padrao");
  });

  it("conta num provedor qualquer (anthropic semeado): a rota da instalação não depende dele", async () => {
    // O caso da issue #1181: o gatilho semeava `anthropic`, e o id BARE do catálogo é da OpenAI.
    // Agora a chave da instalação é a OpenRouter, que atende seja qual for o provedor da conta.
    envMock.OPENROUTER_API_KEY = "sk-or";
    estado.settings = { llm: { provider: "anthropic" } };
    estado.catalogo = { provider: "openai" };

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.origem).toBe("padrao");
  });
});
