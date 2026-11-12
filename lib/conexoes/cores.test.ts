import { describe, expect, it } from "vitest";

import { PISOS, razaoDeContraste } from "@/lib/branding/contraste";
import {
  CHAVES_DE_COR_DA_CONEXAO,
  PALETA_DA_CONEXAO,
  ehCorDaConexao,
  lerCorDaConexao,
  variaveisDaCor,
} from "./cores";

describe("paleta da cor da conexão", () => {
  it("tem exatamente doze chaves, sem repetição, e a paleta cobre todas", () => {
    expect(CHAVES_DE_COR_DA_CONEXAO).toHaveLength(12);
    expect(new Set(CHAVES_DE_COR_DA_CONEXAO).size).toBe(12);
    expect(Object.keys(PALETA_DA_CONEXAO).sort()).toEqual([...CHAVES_DE_COR_DA_CONEXAO].sort());
  });

  it("os doze fundos são distintos em cada tema", () => {
    const claros = CHAVES_DE_COR_DA_CONEXAO.map((c) => PALETA_DA_CONEXAO[c].claro.fundo);
    const escuros = CHAVES_DE_COR_DA_CONEXAO.map((c) => PALETA_DA_CONEXAO[c].escuro.fundo);
    expect(new Set(claros).size).toBe(12);
    expect(new Set(escuros).size).toBe(12);
  });

  for (const chave of CHAVES_DE_COR_DA_CONEXAO) {
    it(`${chave}: texto sobre o fundo passa de 4,5:1 nos dois temas`, () => {
      const d = PALETA_DA_CONEXAO[chave];
      expect(razaoDeContraste(d.claro.texto, d.claro.fundo)).toBeGreaterThanOrEqual(PISOS.texto);
      expect(razaoDeContraste(d.escuro.texto, d.escuro.fundo)).toBeGreaterThanOrEqual(PISOS.texto);
    });
  }

  it("o tema claro é pastel (fundo claro) e o escuro é fundo escuro", () => {
    for (const chave of CHAVES_DE_COR_DA_CONEXAO) {
      const d = PALETA_DA_CONEXAO[chave];
      // Branco contra o fundo claro: perto de 1 = tom leve.
      expect(razaoDeContraste("#ffffff", d.claro.fundo)).toBeLessThan(1.35);
      expect(razaoDeContraste("#ffffff", d.escuro.fundo)).toBeGreaterThan(10);
    }
  });

  it("aceita só as chaves; o resto vira sem cor", () => {
    expect(ehCorDaConexao("rosa")).toBe(true);
    expect(ehCorDaConexao("#fce7f3")).toBe(false);
    expect(ehCorDaConexao("Rosa")).toBe(false);
    expect(lerCorDaConexao("vermelho-sangue")).toBeNull();
    expect(lerCorDaConexao(null)).toBeNull();
    expect(lerCorDaConexao("menta")).toBe("menta");
  });

  it("sem cor não gera variável nenhuma; com cor gera os dois pares", () => {
    expect(variaveisDaCor(null)).toBeNull();
    expect(variaveisDaCor("azul")).toEqual({
      "--etq-conexao-fundo": "#dbeafe",
      "--etq-conexao-texto": "#1e40af",
      "--etq-conexao-fundo-escuro": "#172554",
      "--etq-conexao-texto-escuro": "#bfdbfe",
    });
  });
});
