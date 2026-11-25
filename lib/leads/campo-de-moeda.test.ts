import { describe, expect, it } from "vitest";

import {
  lerCampoDeMoeda,
  moedaDoCampo,
  valorDoCampoDeMoeda,
} from "@/lib/leads/campo-de-moeda";
import { rotuloDoTipo } from "@/lib/schemas/rotulos-do-campo";

/** O espaço do `Intl` (fino, inseparável) vira espaço comum. */
const plano = (s: string) => s.replace(/[  ]/g, " ");

describe("moedaDoCampo — a moeda de UM campo de moeda", () => {
  it("config.moeda válida vence a da organização", () => {
    expect(moedaDoCampo({ config: { moeda: "USD" } }, "BRL")).toBe("USD");
    expect(moedaDoCampo({ config: { moeda: "EUR" } }, "BRL")).toBe("EUR");
  });

  it("o item de settings.fields (moeda no topo) vale igual", () => {
    expect(moedaDoCampo({ moeda: "USD" }, "BRL")).toBe("USD");
  });

  it("ausente cai na moeda da organização (campo antigo)", () => {
    expect(moedaDoCampo({ config: {} }, "BRL")).toBe("BRL");
    expect(moedaDoCampo({}, "EUR")).toBe("EUR");
    expect(moedaDoCampo(null, "MXN")).toBe("MXN");
    expect(moedaDoCampo(undefined, "BRL")).toBe("BRL");
  });

  it("inválida (GBP, minúscula, número, vazio) cai na moeda da organização", () => {
    for (const ruim of ["GBP", "usd", 1, "", null]) {
      expect(moedaDoCampo({ config: { moeda: ruim } }, "BRL")).toBe("BRL");
    }
  });
});

describe("campo de moeda em dólar numa organização em real", () => {
  const campo = { config: { moeda: "USD" } };

  it("o rótulo do tipo diz Moeda (USD)", () => {
    expect(rotuloDoTipo("currency", (x) => x, moedaDoCampo(campo, "BRL"))).toBe("Moeda (USD)");
    expect(rotuloDoTipo("currency", (x) => x, moedaDoCampo({ config: {} }, "BRL"))).toBe("Moeda (BRL)");
  });

  it("escreve em dólar e lê o formato en-US", () => {
    const moeda = moedaDoCampo(campo, "BRL");
    expect(plano(valorDoCampoDeMoeda(1250.5, moeda))).toBe("$1,250.50");
    expect(lerCampoDeMoeda("$1,250.50", moeda)).toBe(125050);
    expect(lerCampoDeMoeda("1,250.50", moeda)).toBe(125050);
  });
});
