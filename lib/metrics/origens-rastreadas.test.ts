import { describe, expect, it } from "vitest";

import { formatarTaxa, resumoDeOrigens } from "./origens-rastreadas";

describe("resumoDeOrigens", () => {
  it("separa rastreado de sem origem e só conta os ganhos de origem rastreada", () => {
    const r = resumoDeOrigens([
      { chave: "google", total: 10, ganhos: 3 },
      { chave: "instagram", total: 5, ganhos: 2 },
      { chave: null, total: 20, ganhos: 8 },
    ]);
    expect(r.comOrigem).toBe(15);
    expect(r.semOrigem).toBe(20);
    expect(r.ganhosRastreados).toBe(5); // os 8 ganhos sem origem ficam de fora
    expect(r.taxaDeGanhoRastreada).toBeCloseTo(5 / 15);
  });

  it("divisor zero: taxa nula e '—', sem NaN", () => {
    const r = resumoDeOrigens([{ chave: null, total: 4, ganhos: 1 }]);
    expect(r.comOrigem).toBe(0);
    expect(r.semOrigem).toBe(4);
    expect(r.ganhosRastreados).toBe(0);
    expect(r.taxaDeGanhoRastreada).toBeNull();
    expect(formatarTaxa(r.taxaDeGanhoRastreada)).toBe("—");
    expect(resumoDeOrigens([]).taxaDeGanhoRastreada).toBeNull();
  });

  it("chave vazia ('') é origem rastreada: só nulo é 'sem origem'", () => {
    const r = resumoDeOrigens([{ chave: "", total: 2, ganhos: 1 }]);
    expect(r.comOrigem).toBe(2);
    expect(r.semOrigem).toBe(0);
  });

  it("formata a taxa com uma casa, como a aba Origens", () => {
    expect(formatarTaxa(1 / 3)).toBe("33.3%");
    expect(formatarTaxa(0)).toBe("0%");
    expect(formatarTaxa(1)).toBe("100%");
  });
});
