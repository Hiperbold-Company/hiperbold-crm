import { describe, expect, it } from "vitest";

import { entrarNoInicio, papelRecebeOInicio, type EntradaParaDecidir } from "./entrada";

const BASE: EntradaParaDecidir = {
  compraLigada: true,
  papel: "admin",
  suporte: false,
  obrigatoriosFaltando: 2,
};

describe("entrarNoInicio (a decisão de para onde /app leva)", () => {
  it("compra ligada, admin e obrigatório faltando: abre o Início", () => {
    expect(entrarNoInicio(BASE)).toBe(true);
  });

  it("obrigatórios todos feitos: segue para a home de sempre", () => {
    expect(entrarNoInicio({ ...BASE, obrigatoriosFaltando: 0 })).toBe(false);
  });

  it("compra desligada: nada muda, mesmo com obrigatório faltando", () => {
    expect(entrarNoInicio({ ...BASE, compraLigada: false })).toBe(false);
  });

  it("só admin recebe o Início; manager, agent, viewer e sem papel seguem a home", () => {
    for (const papel of ["manager", "agent", "viewer", null] as const) {
      expect(entrarNoInicio({ ...BASE, papel }), String(papel)).toBe(false);
    }
  });

  it("sessão de suporte nunca é desviada", () => {
    expect(entrarNoInicio({ ...BASE, suporte: true })).toBe(false);
  });

  it("papelRecebeOInicio concorda com o minRole do menu (admin)", () => {
    expect(papelRecebeOInicio("admin")).toBe(true);
    expect(papelRecebeOInicio("manager")).toBe(false);
    expect(papelRecebeOInicio(null)).toBe(false);
  });
});
