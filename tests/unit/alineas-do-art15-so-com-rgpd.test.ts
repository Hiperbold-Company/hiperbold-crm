// @vitest-environment node
import { describe, expect, it } from "vitest";

import { alineasDoArt15Visiveis } from "@/lib/legal/art15";

/**
 * O cartão das alíneas do art. 15.º do RGPD aparece fora do Brasil — mas não
 * nos Estados Unidos, que não têm esse artigo (país revisado sem lei geral).
 */
describe("alineasDoArt15Visiveis", () => {
  it("Brasil (e a coluna vazia) não mostra", () => {
    expect(alineasDoArt15Visiveis(null)).toBe(false);
    expect(alineasDoArt15Visiveis("BR")).toBe(false);
  });
  it("Portugal mostra", () => {
    expect(alineasDoArt15Visiveis("PT")).toBe(true);
  });
  it("Estados Unidos não mostra", () => {
    expect(alineasDoArt15Visiveis("US")).toBe(false);
  });
});
