import { describe, expect, it } from "vitest";

import { formatarTaxa, resumoDeOrigens } from "./origens-rastreadas";

describe("resumoDeOrigens", () => {
  it("separa rastreado de sem origem e só conta os ganhos de origem rastreada", () => {
    const r = resumoDeOrigens(
      [
        { chave: "google", total: 10, ganhos: 3 },
        { chave: "instagram", total: 5, ganhos: 2 },
        { chave: null, total: 20, ganhos: 8 },
      ],
      35,
      false,
    );
    expect(r.comOrigem).toBe(15);
    expect(r.semOrigem).toBe(20);
    expect(r.ganhosRastreados).toBe(5); // os 8 ganhos sem origem ficam de fora
    expect(r.taxaDeGanhoRastreada).toBeCloseTo(5 / 15);
    expect(r.parcial).toBe(false);
  });

  it("divisor zero: taxa nula e '—', sem NaN", () => {
    const r = resumoDeOrigens([{ chave: null, total: 4, ganhos: 1 }], 4, false);
    expect(r.comOrigem).toBe(0);
    expect(r.semOrigem).toBe(4);
    expect(r.ganhosRastreados).toBe(0);
    expect(r.taxaDeGanhoRastreada).toBeNull();
    expect(formatarTaxa(r.taxaDeGanhoRastreada)).toBe("—");
    expect(resumoDeOrigens([], 0, false).taxaDeGanhoRastreada).toBeNull();
  });

  it("sem linha nula e sem corte: ninguém sem origem, tudo é rastreado", () => {
    const r = resumoDeOrigens([{ chave: "google", total: 10, ganhos: 3 }], 10, false);
    expect(r.semOrigem).toBe(0);
    expect(r.comOrigem).toBe(10);
  });

  it("corte com a linha nula presente: com origem = total − sem origem, mas ganhos e taxa são parciais", () => {
    const r = resumoDeOrigens(
      [
        { chave: "google", total: 10, ganhos: 3 },
        { chave: null, total: 20, ganhos: 8 },
      ],
      100,
      true,
    );
    expect(r.semOrigem).toBe(20);
    expect(r.comOrigem).toBe(80); // inclui origens que o corte escondeu
    expect(r.ganhosRastreados).toBe(3); // só as linhas visíveis
    expect(r.parcial).toBe(true);
  });

  it("corte sem a linha nula: sem origem desconhecido, com origem e taxa também", () => {
    const r = resumoDeOrigens([{ chave: "google", total: 10, ganhos: 3 }], 100, true);
    expect(r.semOrigem).toBeNull();
    expect(r.comOrigem).toBeNull();
    expect(r.taxaDeGanhoRastreada).toBeNull();
    expect(r.parcial).toBe(true);
  });

  it("formata a taxa com uma casa, como a aba Origens", () => {
    expect(formatarTaxa(1 / 3)).toBe("33.3%");
    expect(formatarTaxa(0)).toBe("0%");
    expect(formatarTaxa(1)).toBe("100%");
  });
});
