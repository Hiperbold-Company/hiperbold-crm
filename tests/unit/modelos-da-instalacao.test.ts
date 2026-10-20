/**
 * O FREIO DE CUSTO DA CHAVE DA INSTALAÇÃO — a regra pura (decisão do dono, 16/10/2026).
 *
 * `MODELOS_DA_INSTALACAO` lista os modelos que podem rodar na chave que a
 * Hiperbold paga. O primeiro é o padrão. Quem usa chave própria não é limitado.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  MODELO_PADRAO_DA_INSTALACAO,
  _esquecerAvisosDeModelo,
  agenteUsaChaveDaInstalacao,
  decidirModeloDaChave,
  idNoProvedor,
  lerModelosDaInstalacao,
  listaRestringe,
  idsForaDoCatalogo,
  modeloLiberado,
  modeloPadraoDaInstalacao,
  modelosParaOSeletor,
  primeiraVezDoModelo,
} from "@/lib/ai/modelos-da-instalacao";
import { escolherModeloDoProvedor } from "@/lib/ai/agents/escolher-modelo";
import { acharChave } from "@/lib/instalacao/catalogo";

describe("a lista da configuração", () => {
  it("vazia, ausente ou só espaços vale o padrão (a lista nunca fica vazia)", () => {
    expect(lerModelosDaInstalacao("")).toEqual([MODELO_PADRAO_DA_INSTALACAO]);
    expect(lerModelosDaInstalacao(undefined)).toEqual([MODELO_PADRAO_DA_INSTALACAO]);
    expect(lerModelosDaInstalacao(null)).toEqual([MODELO_PADRAO_DA_INSTALACAO]);
    expect(lerModelosDaInstalacao(" , ;\n ")).toEqual([MODELO_PADRAO_DA_INSTALACAO]);
    expect(MODELO_PADRAO_DA_INSTALACAO).toBe("openai/gpt-6-luna");
  });

  it("separa por vírgula, ponto e vírgula e quebra de linha; tira espaço e repetição", () => {
    expect(lerModelosDaInstalacao(" openai/gpt-6-luna , anthropic/claude-haiku-4-5;openai/gpt-6-luna\ngoogle/x ")).toEqual([
      "openai/gpt-6-luna",
      "anthropic/claude-haiku-4-5",
      "google/x",
    ]);
  });

  it("`*` libera todos e não vira o padrão", () => {
    expect(listaRestringe(["*"])).toBe(false);
    expect(listaRestringe(["openai/gpt-6-luna"])).toBe(true);
    expect(modeloLiberado(["*"], "qualquer/coisa")).toBe(true);
    expect(modeloPadraoDaInstalacao(["*", "google/x"])).toBe("google/x");
    expect(modeloPadraoDaInstalacao(["*"])).toBe(MODELO_PADRAO_DA_INSTALACAO);
    const o = modelosParaOSeletor({ catalogo: [{ model_id: "a/b", display_name: "A" }], liberados: ["*"], provedor: "openrouter", restrito: true });
    expect(o.map((m) => m.model_id)).toEqual(["a/b"]);
  });

  it("o primeiro é o padrão", () => {
    expect(modeloPadraoDaInstalacao(["b/um", "c/dois"])).toBe("b/um");
    expect(modeloPadraoDaInstalacao([])).toBe(MODELO_PADRAO_DA_INSTALACAO);
  });

  it("a tela recusa lista sem modelo e id com lixo; aceita a lista normal", async () => {
    const validar = acharChave("MODELOS_DA_INSTALACAO")?.validar;
    expect(validar).toBeDefined();
    expect(await validar!("openai/gpt-6-luna, anthropic/claude-haiku-4-5")).toBeNull();
    expect(await validar!("*")).toBeNull();
    expect(await validar!("  ,  ")).toMatch(/ao menos um modelo/);
    expect(await validar!("openai/gpt 6")).toMatch(/identificador/);
  });
});

describe("o modelo está liberado?", () => {
  const lista = ["openai/gpt-6-luna"];

  it("compara o id canônico, sem diferenciar caixa", () => {
    expect(modeloLiberado(lista, "openai/gpt-6-luna")).toBe(true);
    expect(modeloLiberado(lista, "OpenAI/GPT-6-Luna")).toBe(true);
    expect(modeloLiberado(lista, "anthropic/claude-sonnet-5")).toBe(false);
  });

  it("id puro do catálogo de um provedor direto vira o canônico", () => {
    expect(modeloLiberado(lista, "gpt-6-luna", "openai")).toBe(true);
    expect(modeloLiberado(lista, "gpt-6-luna")).toBe(true);
    expect(modeloLiberado(lista, "gpt-5.6-terra", "openai")).toBe(false);
  });
});

describe("idNoProvedor", () => {
  it("roteador leva o id inteiro; provedor direto, só o nome; fabricante errado, nada", () => {
    expect(idNoProvedor("openrouter", "openai/gpt-6-luna")).toBe("openai/gpt-6-luna");
    expect(idNoProvedor("openai", "openai/gpt-6-luna")).toBe("gpt-6-luna");
    expect(idNoProvedor("anthropic", "openai/gpt-6-luna")).toBeNull();
  });
});

describe("o freio (decidirModeloDaChave)", () => {
  const lista = ["openai/gpt-6-luna", "openai/gpt-6-sol"];

  it("chave da instalação + modelo fora da lista → o padrão (o primeiro)", () => {
    const d = decidirModeloDaChave({
      lista,
      origemDaChave: "chave_da_instalacao",
      provedor: "openrouter",
      modelId: "anthropic/claude-opus-5",
    });
    expect(d).toEqual({ modelId: "openai/gpt-6-luna", trocado: true, pedido: "anthropic/claude-opus-5" });
  });

  it("chave da instalação + modelo na lista (qualquer posição) → inalterado", () => {
    const d = decidirModeloDaChave({
      lista,
      origemDaChave: "chave_da_instalacao",
      provedor: "openrouter",
      modelId: "openai/gpt-6-sol",
    });
    expect(d.trocado).toBe(false);
    expect(d.modelId).toBe("openai/gpt-6-sol");
  });

  it("chave PRÓPRIA da empresa (BYOK) → nunca troca, mesmo fora da lista", () => {
    const d = decidirModeloDaChave({
      lista,
      origemDaChave: "credencial_da_organizacao",
      provedor: "openrouter",
      modelId: "anthropic/claude-opus-5",
    });
    expect(d).toEqual({ modelId: "anthropic/claude-opus-5", trocado: false, pedido: "anthropic/claude-opus-5" });
  });

  it("provedor direto recebe o padrão escrito do jeito dele", () => {
    const d = decidirModeloDaChave({
      lista,
      origemDaChave: "chave_da_instalacao",
      provedor: "openai",
      modelId: "gpt-5.6-terra",
    });
    expect(d.modelId).toBe("gpt-6-luna");
    expect(d.trocado).toBe(true);
  });

  it("provedor que não executa o padrão mantém o pedido (nunca derruba o turno) e sinaliza", () => {
    const d = decidirModeloDaChave({
      lista,
      origemDaChave: "chave_da_instalacao",
      provedor: "anthropic",
      modelId: "claude-sonnet-5",
    });
    expect(d.trocado).toBe(false);
    expect(d.modelId).toBe("claude-sonnet-5");
    expect(d.semTraducao).toBe(true);
  });
});

describe("aviso único por organização e modelo", () => {
  beforeEach(() => _esquecerAvisosDeModelo());

  it("só a primeira vez de cada par devolve true", () => {
    expect(primeiraVezDoModelo("org-1", "a/b")).toBe(true);
    expect(primeiraVezDoModelo("org-1", "a/b")).toBe(false);
    expect(primeiraVezDoModelo("org-1", "a/c")).toBe(true);
    expect(primeiraVezDoModelo("org-2", "a/b")).toBe(true);
  });
});

describe("o seletor de modelos", () => {
  const catalogo = [
    { model_id: "openai/gpt-6-luna", display_name: "OpenAI: GPT-6 Luna", context_window: 1 },
    { model_id: "anthropic/claude-opus-5", display_name: "Claude Opus 5", context_window: 2 },
    { model_id: "google/gemini-x", display_name: "Gemini X", context_window: 3 },
  ];

  it("sem chave própria lista SÓ os liberados, com o nome amigável do Luna e o padrão primeiro", () => {
    const o = modelosParaOSeletor({
      catalogo,
      liberados: ["openai/gpt-6-luna", "google/gemini-x"],
      provedor: "openrouter",
      restrito: true,
    });
    expect(o.map((m) => m.model_id)).toEqual(["openai/gpt-6-luna", "google/gemini-x"]);
    expect(o[0]?.display_name).toBe("Luna (OpenAI)");
    expect(o[1]?.display_name).toBe("Gemini X");
  });

  it("com chave própria mostra o catálogo inteiro, como antes", () => {
    const o = modelosParaOSeletor({ catalogo, liberados: ["openai/gpt-6-luna"], provedor: "openrouter", restrito: false });
    expect(o.map((m) => m.model_id)).toEqual(catalogo.map((c) => c.model_id));
  });

  it("liberado que o catálogo ainda não conhece entra mesmo assim (o seletor não fica vazio)", () => {
    const o = modelosParaOSeletor({ catalogo: [], liberados: ["openai/gpt-6-luna"], provedor: "openrouter", restrito: true });
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ model_id: "openai/gpt-6-luna", display_name: "Luna (OpenAI)" });
  });

  it("qualquer provedor escolhido na tela: a chave da instalação sai pela OpenRouter, então o liberado entra com o id inteiro", () => {
    const o = modelosParaOSeletor({
      catalogo: [{ model_id: "gpt-6-luna", display_name: "GPT-6 Luna" }, { model_id: "gpt-5-mini", display_name: "Mini" }],
      liberados: ["openai/gpt-6-luna"],
      provedor: "openai",
      restrito: true,
    });
    expect(o.map((m) => m.model_id)).toEqual(["openai/gpt-6-luna"]);
    expect(o[0]?.display_name).toBe("Luna (OpenAI)");
  });

  it("provedor direto com catálogo de Claude: o seletor mostra só o Luna — sem Claude", () => {
    // Antes, a lista só com o Luna da OpenRouter não tinha rota no provedor direto e o seletor caía
    // no catálogo inteiro (com os Claude). A chave da instalação agora é sempre a OpenRouter.
    const o = modelosParaOSeletor({ catalogo, liberados: ["openai/gpt-6-luna"], provedor: "anthropic", restrito: true });
    expect(o.map((m) => m.model_id)).toEqual(["openai/gpt-6-luna"]);
    expect(o.map((m) => m.model_id)).not.toContain("anthropic/claude-opus-5");
  });
});

describe("quando o agente roda na chave da instalação", () => {
  const MARCADOR = "__instalacao__";
  const valida = [{ provider: "openrouter", validada: true }];

  it("sem credencial escolhida e sem chave própria do provedor → instalação", () => {
    for (const credentialId of ["", MARCADOR]) {
      expect(
        agenteUsaChaveDaInstalacao({ provedor: "openrouter", credentialId, marcadorDaInstalacao: MARCADOR, credenciais: [] }),
      ).toBe(true);
    }
  });

  it("credencial escolhida → chave própria", () => {
    expect(
      agenteUsaChaveDaInstalacao({ provedor: "openrouter", credentialId: "uuid-1", marcadorDaInstalacao: MARCADOR, credenciais: valida }),
    ).toBe(false);
  });

  it("sem escolha mas com chave própria validada do provedor → o motor usa a dela", () => {
    expect(
      agenteUsaChaveDaInstalacao({ provedor: "openrouter", credentialId: MARCADOR, marcadorDaInstalacao: MARCADOR, credenciais: valida }),
    ).toBe(false);
  });

  it("chave própria de OUTRO provedor, ou ainda não validada, não conta", () => {
    expect(
      agenteUsaChaveDaInstalacao({
        provedor: "openrouter",
        credentialId: "",
        marcadorDaInstalacao: MARCADOR,
        credenciais: [{ provider: "openai", validada: true }, { provider: "openrouter", validada: false }],
      }),
    ).toBe(true);
  });
});

describe("agente novo sem modelo escolhido", () => {
  const luna = { model_id: "openai/gpt-6-luna", supports_tools: true, input_price_per_million_cents: 50, output_price_per_million_cents: 100 };
  const barato = { model_id: "x/barato", supports_tools: true, input_price_per_million_cents: 1, output_price_per_million_cents: 1, is_default_for_provider: true };

  it("na chave da instalação nasce com o primeiro modelo liberado que o catálogo conhece", () => {
    const e = escolherModeloDoProvedor([barato, luna], { liberados: ["openai/gpt-6-luna"], provedor: "openrouter" });
    expect(e).toEqual({ escolhido: true, modelId: "openai/gpt-6-luna", origem: "curado" });
  });

  it("vence o curado e o mais barato do catálogo; sem a opção, o curado segue vencendo", () => {
    expect(escolherModeloDoProvedor([barato, luna])).toMatchObject({ modelId: "x/barato" });
    expect(escolherModeloDoProvedor([barato, luna], { liberados: ["openai/gpt-6-luna"], provedor: "openrouter" })).toMatchObject({
      modelId: "openai/gpt-6-luna",
    });
  });

  it("provedor direto: acha o liberado pelo nome puro", () => {
    const e = escolherModeloDoProvedor([{ model_id: "gpt-6-luna", supports_tools: true }], {
      liberados: ["openai/gpt-6-luna"],
      provedor: "openai",
    });
    expect(e).toMatchObject({ escolhido: true, modelId: "gpt-6-luna" });
  });

  it("catálogo vazio continua sendo catálogo vazio (a regra de antes; o freio de execução protege o custo)", () => {
    expect(escolherModeloDoProvedor([], { liberados: ["openai/gpt-6-luna"], provedor: "openrouter" })).toEqual({
      escolhido: false,
      motivo: "catalogo_vazio",
    });
  });

  it("liberado que o catálogo não tem, ou sem ferramentas, ou que o provedor não executa: vale a regra normal", () => {
    expect(escolherModeloDoProvedor([barato], { liberados: ["openai/gpt-6-luna"], provedor: "openrouter" })).toMatchObject({ modelId: "x/barato" });
    expect(
      escolherModeloDoProvedor([{ ...luna, supports_tools: false }, barato], { liberados: ["openai/gpt-6-luna"], provedor: "openrouter" }),
    ).toMatchObject({ modelId: "x/barato" });
    expect(
      escolherModeloDoProvedor([{ model_id: "claude-x", supports_tools: true, is_default_for_provider: true }], {
        liberados: ["openai/gpt-6-luna"],
        provedor: "anthropic",
      }),
    ).toMatchObject({ modelId: "claude-x" });
  });
});

describe("modeloLiberado: com e sem fabricante, nos dois sentidos", () => {
  it("lista sem fabricante libera o id puro, mas NÃO um id com fabricante (o nome sozinho não diz de quem é)", () => {
    expect(modeloLiberado(["gpt-6-luna"], "gpt-6-luna")).toBe(true);
    expect(modeloLiberado(["gpt-6-luna"], "openai/gpt-6-luna")).toBe(false);
    // O caso que o freio existe para barrar: mesmo nome, outro fabricante.
    expect(modeloLiberado(["gpt-6-luna"], "anthropic/gpt-6-luna")).toBe(false);
    expect(modeloLiberado(["gpt-6-luna"], "maliciosa/gpt-6-luna", "openrouter")).toBe(false);
  });
  it("lista com fabricante libera o id puro", () => {
    expect(modeloLiberado(["openai/gpt-6-luna"], "gpt-6-luna")).toBe(true);
  });
  it("fabricantes diferentes nunca se casam", () => {
    expect(modeloLiberado(["anthropic/x"], "openai/x")).toBe(false);
  });
  it("idsForaDoCatalogo acusa o id que não existe e aceita as duas grafias", () => {
    const catalogo = [{ provider: "openai", model_id: "gpt-6-luna" }];
    expect(idsForaDoCatalogo(["gpt-6-luna", "openai/gpt-6-luna", "openai/gpt-6-lunaa"], catalogo)).toEqual([
      "openai/gpt-6-lunaa",
    ]);
  });
});
