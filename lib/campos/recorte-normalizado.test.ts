import { describe, expect, it } from "vitest";

import { cargoEEmpresa } from "@/lib/contacts/cargo-e-empresa";

import { chaveEhRestrita, normalizarChaveDeCampo, preservarValoresRestritos, recortarValores } from "./recorte-por-papel";

/**
 * O recorte e o leitor tolerante usam a MESMA normalização de chave. Antes, `recortarValores`
 * comparava só em minúsculas e `cargoEEmpresa` normalizava acento e pontuação: um valor gravado
 * como "Company Name" escapava da chave restrita `company_name` e era lido como empresa.
 */
describe("recortarValores — chave normalizada", () => {
  it("⭐ chave restrita `company_name` recorta o valor gravado como \"Company Name\"", () => {
    const campos = { "Company Name": "Segredo SA", outra: "fica" };
    const recortado = recortarValores(campos, new Set(["company_name"]), "manager");
    expect(recortado).toEqual({ outra: "fica" });
    expect(cargoEEmpresa(recortado).empresa).toBeNull();
    // controle: sem o recorte o leitor tolerante acharia o valor
    expect(cargoEEmpresa(campos).empresa).toBe("Segredo SA");
  });

  it("acento e pontuação também: restrita `cargo_posicao` recorta \"Cargo / Posição\"", () => {
    expect(recortarValores({ "Cargo / Posição": "x" }, new Set(["cargo_posicao"]), "agent")).toEqual({});
  });

  it("não afrouxa: o casamento em minúsculas de sempre continua recortando", () => {
    expect(recortarValores({ CPF: "1", Nome: "a" }, new Set(["cpf"]), "manager")).toEqual({ Nome: "a" });
    // chave restrita com pontuação que a normalização mudaria: a forma crua continua valendo
    expect(recortarValores({ "cpf-titular": "1" }, new Set(["cpf-titular"]), "manager")).toEqual({});
  });

  it("administrador recebe tudo; nada a tirar devolve o MESMO objeto", () => {
    const campos = { "Company Name": "Segredo SA" };
    expect(recortarValores(campos, new Set(["company_name"]), "admin")).toBe(campos);
    const outros = { cor: "azul" };
    expect(recortarValores(outros, new Set(["company_name"]), "manager")).toBe(outros);
  });

  it("normalizarChaveDeCampo", () => {
    expect(normalizarChaveDeCampo("  Company Name ")).toBe("company_name");
    expect(normalizarChaveDeCampo("Cargo / Posição")).toBe("cargo_posicao");
  });
});

/**
 * O preservador usa o MESMO predicado: o gerente não recebe "Company Name" (o recorte o tira pela
 * forma normalizada), então ao salvar o PATCH não pode apagá-lo.
 */
describe("preservarValoresRestritos — chave normalizada", () => {
  const restritas = new Set(["company_name"]);

  it("mantém o valor gravado como 'Company Name' quando a entrada não o traz", () => {
    const saida = preservarValoresRestritos({ cargo: "Dono" }, { "Company Name": "ACME", cargo: "x" }, restritas);
    expect(saida).toEqual({ cargo: "Dono", "Company Name": "ACME" });
  });

  it("entrada com a forma normalizada conta como presente (admin troca o valor)", () => {
    const saida = preservarValoresRestritos({ company_name: "Nova" }, { "Company Name": "ACME" }, restritas);
    expect(saida).toEqual({ company_name: "Nova" });
  });

  it("chaveEhRestrita casa minúsculas e forma normalizada, e nada sem restritas", () => {
    const e = chaveEhRestrita(restritas);
    expect(e("COMPANY_NAME")).toBe(true);
    expect(e("Company Name")).toBe(true);
    expect(e("cargo")).toBe(false);
    expect(chaveEhRestrita(new Set())("company_name")).toBe(false);
  });
});
