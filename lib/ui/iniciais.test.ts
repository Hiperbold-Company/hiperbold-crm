import { describe, expect, it } from "vitest";

import { inicialDoNome, iniciaisDoNome } from "./iniciais";

/**
 * As iniciais saem por LETRA, nunca por unidade UTF-16: "Rejeane 🧡" mostrava
 * "R�" no círculo do Chat, porque `slice(0, 2)` partia o emoji ao meio.
 */
describe("iniciaisDoNome", () => {
  it("⭐ emoji no fim não vira meio caractere", () => {
    expect(iniciaisDoNome("Rejeane 🧡")).toBe("R");
  });

  it("⭐ emoji no começo é ignorado: primeira e última palavra com letra", () => {
    expect(iniciaisDoNome("🧡 Maria Silva")).toBe("MS");
  });

  it("acento fica inteiro, composto ou decomposto", () => {
    expect(iniciaisDoNome("Élida Ó")).toBe("ÉÓ");
    expect(iniciaisDoNome("Élida Ó")).toBe("ÉÓ");
  });

  it("escrita sem caixa não quebra", () => {
    expect(iniciaisDoNome("李 小龍")).toBe("李小");
  });

  it("⭐ nome só com emoji não inventa inicial: quem chama usa o seu fallback", () => {
    expect(iniciaisDoNome("🧡🧡")).toBeNull();
    expect(iniciaisDoNome("1️⃣ 🧡")).toBeNull();
    expect(iniciaisDoNome("   ")).toBeNull();
    expect(iniciaisDoNome(null)).toBeNull();
  });

  it("emoji colado na palavra não esconde a letra", () => {
    expect(iniciaisDoNome("🧡Maria")).toBe("M");
  });

  it("palavra única: uma letra por padrão, duas quando pedido", () => {
    expect(iniciaisDoNome("Ana")).toBe("A");
    expect(iniciaisDoNome("Ana", { palavraUnica: 2 })).toBe("AN");
    expect(iniciaisDoNome("Ana Paula Souza")).toBe("AS");
  });

  it("inicialDoNome: uma letra só, sem partir emoji", () => {
    expect(inicialDoNome("🧡 Rejeane")).toBe("R");
    expect(inicialDoNome("🧡")).toBeNull();
  });
});
