import { describe, expect, it } from "vitest";

import { mascaraDaFaixa } from "@/components/shell/redesign/BarraDaArea";

// Configurações tem mais abas do que cabem: a faixa rola até a aba atual e o
// primeiro rótulo ficava cortado ao meio, sem sinal de rolagem.
describe("faixa de abas da área", () => {
  it("sem rolagem, sem máscara", () => {
    expect(mascaraDaFaixa(0, 800, 800)).toBeUndefined();
  });
  it("rolada até o fim: esmaece só a esquerda", () => {
    const m = mascaraDaFaixa(400, 800, 1200);
    expect(m).toContain("transparent 0");
    expect(m).toContain("#000 100%");
  });
  it("no começo com mais à direita: esmaece só a direita", () => {
    const m = mascaraDaFaixa(0, 800, 1200);
    expect(m).toContain("#000 0");
    expect(m).toContain("transparent 100%");
  });
  it("no meio: esmaece os dois lados", () => {
    const m = mascaraDaFaixa(200, 800, 1200)!;
    expect(m.match(/transparent/g)).toHaveLength(2);
  });
});
