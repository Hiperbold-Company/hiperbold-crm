import { describe, expect, it } from "vitest";

import { camposDoFunil } from "@/lib/leads/campos-do-funil";

import {
  alteracaoDeDefinicaoSchema,
  camposObrigatoriosDoFunil,
  estatisticasDe,
  incoerenciaDaDefinicao,
  novaDefinicaoSchema,
  paraCampoDoFunil,
  presetDoPadrao,
  PRESETS_DE_VALIDACAO,
} from "./definicoes";

const BASE = {
  key: "cpf",
  label: "CPF",
  type: "text" as const,
  entidade: "contato" as const,
  obrigatorio: false,
  grupo: null,
  descricao: null,
  publico: true,
  sempre_visivel: false,
  exibir_no_perfil: false,
  dica_de_ajuda: null,
  config: {},
};

describe("novaDefinicaoSchema / alteracaoDeDefinicaoSchema", () => {
  it("criar exige entidade, key, label e type, e recusa chave fora do formato", () => {
    expect(novaDefinicaoSchema.safeParse({ entidade: "negocio", key: "origem", label: "Origem", type: "text" }).success).toBe(true);
    expect(novaDefinicaoSchema.safeParse({ entidade: "negocio", key: "1x", label: "X", type: "text" }).success).toBe(false);
    expect(novaDefinicaoSchema.safeParse({ entidade: "lead", key: "x", label: "X", type: "text" }).success).toBe(false);
    expect(novaDefinicaoSchema.safeParse({ entidade: "negocio", key: "x", label: "X", type: "rating" }).success).toBe(false);
  });

  it("alterar RECUSA key, type e entidade (strict) — quem os manda acha que mudou e não mudou", () => {
    expect(alteracaoDeDefinicaoSchema.safeParse({ label: "Novo" }).success).toBe(true);
    expect(alteracaoDeDefinicaoSchema.safeParse({ type: "number" }).success).toBe(false);
    expect(alteracaoDeDefinicaoSchema.safeParse({ key: "outra" }).success).toBe(false);
    expect(alteracaoDeDefinicaoSchema.safeParse({ entidade: "negocio" }).success).toBe(false);
    expect(alteracaoDeDefinicaoSchema.safeParse({ organization_id: "x" }).success).toBe(false);
  });

  it("config aceita só as chaves que a projeção conhece", () => {
    expect(alteracaoDeDefinicaoSchema.safeParse({ config: { padrao: "^\\d+$" } }).success).toBe(true);
    expect(alteracaoDeDefinicaoSchema.safeParse({ config: { qualquer: 1 } }).success).toBe(false);
  });
});

describe("incoerenciaDaDefinicao", () => {
  it("lista fechada sem opção, opção em tipo que não é lista, valores repetidos e regex quebrada", () => {
    expect(incoerenciaDaDefinicao("select", {})).toMatch(/opção/);
    expect(incoerenciaDaDefinicao("text", { options: [{ value: "a", label: "A" }] })).toMatch(/lista/);
    expect(
      incoerenciaDaDefinicao("multiselect", { options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] }),
    ).toMatch(/repetidos/);
    expect(incoerenciaDaDefinicao("text", { padrao: "^(" })).toMatch(/expressão/);
    expect(incoerenciaDaDefinicao("text", { multiple: true })).toMatch(/pesquisável/);
    expect(incoerenciaDaDefinicao("searchable_select", { multiple: true })).toBeNull();
  });
});

describe("paraCampoDoFunil — o espelho da projeção do banco", () => {
  it("sai na forma de settings.fields e passa por camposDoFunil sem perder as props novas", () => {
    const item = paraCampoDoFunil(
      { ...BASE, publico: false, dica_de_ajuda: "Só números", config: { padrao: "^\\d{11}$" } },
      { ao_ganhar: true },
    );
    expect(item).toEqual({
      key: "cpf",
      label: "CPF",
      type: "text",
      escopo: "contato",
      publico: false,
      dica_de_ajuda: "Só números",
      padrao: "^\\d{11}$",
      obrigatorio_em: { ao_ganhar: true },
    });
    const [lido] = camposDoFunil({ fields: [item] });
    expect(lido?.publico).toBe(false);
    expect(lido?.dica_de_ajuda).toBe("Só números");
    expect(lido?.escopo).toBe("contato");
  });

  it("negócio público sem nada marcado é o item mínimo de sempre (ausência é o padrão)", () => {
    expect(paraCampoDoFunil({ ...BASE, entidade: "negocio" })).toEqual({ key: "cpf", label: "CPF", type: "text" });
  });

  it("o funil legado (sem definição na organização) continua lido como sempre", () => {
    const legado = { fields: [{ key: "dor", label: "Dor", type: "text", obrigatorio_em: { etapas: [] } }] };
    expect(camposDoFunil(legado).map((c) => c.key)).toEqual(["dor"]);
  });
});

describe("camposObrigatoriosDoFunil", () => {
  it("lê o mapa do funil e joga fora o que é lixo", () => {
    expect(
      camposObrigatoriosDoFunil({ campos_obrigatorios: { origem: { ao_perder: true }, "1ruim": { ao_ganhar: true }, x: 3 } }),
    ).toEqual({ origem: { ao_perder: true } });
    expect(camposObrigatoriosDoFunil({ campos_obrigatorios: [] })).toEqual({});
    expect(camposObrigatoriosDoFunil(null)).toEqual({});
  });
});

describe("presets e estatísticas", () => {
  it("o padrão gravado volta como o preset que é, e o resto é custom", () => {
    expect(presetDoPadrao(PRESETS_DE_VALIDACAO.email)).toBe("email");
    expect(presetDoPadrao("")).toBe("nenhum");
    expect(presetDoPadrao("^abc$")).toBe("custom");
  });

  it("taxa com uma casa, vazios = total − preenchidos, e arquivo conta pelos anexos", () => {
    const quando = { created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" };
    expect(estatisticasDe({ total: 3, preenchidos: 1 }, { type: "text", ...quando })).toMatchObject({
      total: 3,
      preenchidos: 1,
      vazios: 2,
      taxa: 33.3,
    });
    expect(estatisticasDe({ total: 0, preenchidos: 0 }, { type: "text", ...quando }).taxa).toBe(0);
    expect(estatisticasDe({ total: 4, preenchidos: 0, anexados: 2 }, { type: "file", ...quando }).preenchidos).toBe(2);
  });
});
