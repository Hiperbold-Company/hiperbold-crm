/**
 * PROVEDOR E MODELO QUE O PLANO PERMITE — as opções da tela e a recusa do servidor (20/10/2026).
 *
 * A tela só oferece a chave do plano ("Chave própria do Hiperbold CRM (OpenRouter)") e os provedores
 * que a empresa conectou. Tela não é cerca: o servidor recusa o resto no salvar e no publicar.
 */
import { describe, expect, it } from "vitest";

import { escolherModeloDoProvedor } from "@/lib/ai/agents/escolher-modelo";
import {
  opcaoInicialDoAgenteNovo,
  opcoesDeProvedor,
  ROTULO_DA_OPCAO_DO_PLANO,
  VALOR_DA_OPCAO_DO_PLANO,
  VALOR_DO_PAR_NAO_PERMITIDO,
  valorDaOpcaoEmVigor,
} from "@/lib/ai/agents/opcoes-de-provedor";
import { recusaDaChaveDaInstalacao, recusaDaVersao } from "@/lib/ai/agents/provedor-permitido";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";

const MARCADOR = "__instalacao__";
const LUNA = ["openai/gpt-6-luna"];

describe("opções do campo 'Empresa de inteligência artificial'", () => {
  it("sem credencial nenhuma, só a chave do plano, com o rótulo exato", () => {
    const opcoes = opcoesDeProvedor({ credenciais: [], provedoresConhecidos: PROVEDORES });
    expect(opcoes).toHaveLength(1);
    expect(opcoes[0]).toMatchObject({
      valor: VALOR_DA_OPCAO_DO_PLANO,
      rotulo: "Chave própria do Hiperbold CRM (OpenRouter)",
      provider: "openrouter",
      credentialId: null,
    });
    expect(opcoes[0]!.rotulo).toBe(ROTULO_DA_OPCAO_DO_PLANO);
  });

  it("acrescenta só os provedores com credencial ATIVA e VALIDADA; os desconectados não aparecem", () => {
    const opcoes = opcoesDeProvedor({
      provedoresConhecidos: PROVEDORES,
      credenciais: [
        { id: "c-openai", provider: "openai", conectada: true },
        { id: "c-anthropic", provider: "anthropic", conectada: false },
        // A chave do Jev não conversa: não é provedor de agente.
        { id: "c-jev", provider: "typesafe", conectada: true },
      ],
    });
    expect(opcoes.map((o) => o.valor)).toEqual([VALOR_DA_OPCAO_DO_PLANO, "openai"]);
    expect(opcoes[1]).toMatchObject({ provider: "openai", credentialId: "c-openai" });
  });

  it("a OpenRouter da empresa aparece separada da do plano, como 'OpenRouter (sua chave)'", () => {
    const opcoes = opcoesDeProvedor({
      provedoresConhecidos: PROVEDORES,
      credenciais: [{ id: "c-or", provider: "openrouter", conectada: true }],
    });
    expect(opcoes.map((o) => o.rotulo)).toEqual([
      "Chave própria do Hiperbold CRM (OpenRouter)",
      "OpenRouter (sua chave)",
    ]);
    expect(opcoes[0]!.valor).not.toBe(opcoes[1]!.valor);
  });

  it("com duas chaves do mesmo provedor, a mais recente é a escolhida", () => {
    const opcoes = opcoesDeProvedor({
      provedoresConhecidos: PROVEDORES,
      credenciais: [
        { id: "velha", provider: "openai", conectada: true, criadaEm: "2026-01-01T00:00:00Z" },
        { id: "nova", provider: "openai", conectada: true, criadaEm: "2026-09-01T00:00:00Z" },
      ],
    });
    expect(opcoes.find((o) => o.provider === "openai")?.credentialId).toBe("nova");
  });

  it("qual opção o formulário tem: plano, provedor conectado ou par que deixou de ser permitido", () => {
    const opcoes = opcoesDeProvedor({
      provedoresConhecidos: PROVEDORES,
      credenciais: [{ id: "c-openai", provider: "openai", conectada: true }],
    });
    const valor = (provider: string, credentialId: string) =>
      valorDaOpcaoEmVigor({ provider, credentialId, marcadorDaInstalacao: MARCADOR, opcoes });

    expect(valor("openrouter", MARCADOR)).toBe(VALOR_DA_OPCAO_DO_PLANO);
    expect(valor("openai", "c-openai")).toBe("openai");
    // Agente antigo: Anthropic na "chave da instalação" — o plano não oferece mais.
    expect(valor("anthropic", MARCADOR)).toBe(VALOR_DO_PAR_NAO_PERMITIDO);
    // Provedor que a empresa desconectou depois de salvar.
    expect(valor("anthropic", "c-sumiu")).toBe(VALOR_DO_PAR_NAO_PERMITIDO);
  });

  it("agente novo: o provedor que a empresa já usa, se conectado; senão a chave do plano", () => {
    const opcoes = opcoesDeProvedor({
      provedoresConhecidos: PROVEDORES,
      credenciais: [{ id: "c-openai", provider: "openai", conectada: true }],
    });
    expect(opcaoInicialDoAgenteNovo({ provedorPadrao: "openai", opcoes }).valor).toBe("openai");
    expect(opcaoInicialDoAgenteNovo({ provedorPadrao: "anthropic", opcoes }).valor).toBe(VALOR_DA_OPCAO_DO_PLANO);
    expect(opcaoInicialDoAgenteNovo({ opcoes }).valor).toBe(VALOR_DA_OPCAO_DO_PLANO);
  });
});

describe("recusa do servidor na chave da instalação", () => {
  it("aceita OpenRouter + Luna sem credencial própria", () => {
    expect(
      recusaDaChaveDaInstalacao({ provider: "openrouter", model: "openai/gpt-6-luna", credential_id: null }, LUNA),
    ).toBeNull();
  });

  it("recusa outro provedor na chave da instalação (anthropic, openai…)", () => {
    for (const provider of ["anthropic", "openai", "google"]) {
      const r = recusaDaChaveDaInstalacao({ provider, model: "qualquer", credential_id: null }, LUNA);
      expect(r?.code, provider).toBe("provider_not_allowed");
    }
  });

  it("recusa modelo fora de MODELOS_DA_INSTALACAO na chave da instalação", () => {
    const r = recusaDaChaveDaInstalacao(
      { provider: "openrouter", model: "anthropic/claude-opus-5", credential_id: null },
      LUNA,
    );
    expect(r?.code).toBe("model_not_allowed");
  });

  it("lista com '*' libera todos os modelos (freio desligado pelo operador)", () => {
    expect(
      recusaDaChaveDaInstalacao({ provider: "openrouter", model: "anthropic/claude-opus-5", credential_id: null }, ["*"]),
    ).toBeNull();
  });

  it("a variante :batch é recusada em qualquer chave, inclusive a própria", () => {
    expect(
      recusaDaChaveDaInstalacao({ provider: "openrouter", model: "openai/gpt-6-luna:batch", credential_id: null }, ["*"])?.code,
    ).toBe("model_not_allowed");
    expect(
      recusaDaChaveDaInstalacao({ provider: "openrouter", model: "openai/gpt-6-luna:batch", credential_id: "c1" }, LUNA)?.code,
    ).toBe("model_not_allowed");
  });

  it("com chave própria, o modelo é livre (o custo é da empresa)", () => {
    expect(
      recusaDaChaveDaInstalacao({ provider: "anthropic", model: "claude-opus-5", credential_id: "c1" }, LUNA),
    ).toBeNull();
  });
});

/** Admin falso: devolve a credencial pedida (ou nenhuma) e registra os filtros usados. */
function adminComCredencial(linha: { provider: string; is_active: boolean } | null) {
  const filtros: Array<[string, unknown]> = [];
  const q = {
    select: () => q,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return q;
    },
    maybeSingle: async () => ({ data: linha }),
  };
  return { admin: { from: () => q } as never, filtros };
}

describe("recusaDaVersao — a credencial escolhida", () => {
  const v = { provider: "openai", model: "gpt-6-luna", credential_id: "c1" };

  it("credencial desta empresa, ativa e do mesmo provedor passa — e a consulta é escopada pela organização", async () => {
    const { admin, filtros } = adminComCredencial({ provider: "openai", is_active: true });
    expect(await recusaDaVersao(admin, "org-1", v, LUNA)).toBeNull();
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
  });

  it.each([
    ["inexistente (ou de outra empresa)", null],
    ["inativa", { provider: "openai", is_active: false }],
    ["de outro provedor", { provider: "anthropic", is_active: true }],
  ])("credencial %s é recusada", async (_nome, linha) => {
    const { admin } = adminComCredencial(linha);
    expect((await recusaDaVersao(admin, "org-1", v, LUNA))?.code).toBe("provider_not_allowed");
  });
});

describe("variante :batch fora da escolha automática de modelo", () => {
  it("nunca é escolhida, mesmo sendo a mais barata e com ferramentas", () => {
    const escolha = escolherModeloDoProvedor([
      { model_id: "openai/gpt-6-luna:batch", supports_tools: true, input_price_per_million_cents: 1, output_price_per_million_cents: 1 },
      { model_id: "openai/gpt-6-luna", supports_tools: true, input_price_per_million_cents: 5, output_price_per_million_cents: 5 },
    ]);
    expect(escolha).toMatchObject({ escolhido: true, modelId: "openai/gpt-6-luna" });
  });
});
