/**
 * EXECUÇÕES DE UMA AUTOMAÇÃO — o "quando" no fuso da empresa.
 *
 * A página é de servidor, e o contêiner roda em UTC: sem fuso explícito, a hora
 * de cada execução aparecia 3h adiantada para uma empresa em Brasília. A data e a
 * hora saem no fuso da empresa ativa (`organizations.timezone`); sem fuso válido,
 * no padrão.
 */
import { afterEach, describe, expect, it } from "vitest";

import { dataHoraDaExecucao } from "@/lib/automacoes/data-da-lista";

const tzOriginal = process.env.TZ;
afterEach(() => {
  process.env.TZ = tzOriginal;
});

// 23/11/2026 22:30 em Brasília = 24/11/2026 01:30 UTC = 24/11/2026 10:30 em Tóquio
const fimDaNoite = "2026-11-24T01:30:00.000Z";
const semEspacoEstreito = (s: string) => s.replace(/[  ]/g, " ");

describe("dataHoraDaExecucao — data e hora no fuso da empresa", () => {
  it("servidor em UTC mostra a hora de Brasília para empresa em Brasília", () => {
    process.env.TZ = "UTC";
    expect(dataHoraDaExecucao(fimDaNoite, "pt-BR", "America/Sao_Paulo")).toBe("23/11/2026, 22:30");
  });

  it("empresa fora do Brasil vê a hora do fuso dela", () => {
    process.env.TZ = "UTC";
    expect(dataHoraDaExecucao(fimDaNoite, "pt-BR", "Asia/Tokyo")).toBe("24/11/2026, 10:30");
  });

  it("sem fuso, ou com fuso que o Intl recusa, cai no padrão", () => {
    process.env.TZ = "UTC";
    for (const fuso of [null, undefined, "", "Brasília"]) {
      expect(dataHoraDaExecucao(fimDaNoite, "pt-BR", fuso)).toBe("23/11/2026, 22:30");
    }
  });

  it("sem instante, um travessão", () => {
    expect(dataHoraDaExecucao(null, "pt-BR", "America/Sao_Paulo")).toBe("—");
  });

  it("segue o idioma da pessoa", () => {
    process.env.TZ = "UTC";
    expect(semEspacoEstreito(dataHoraDaExecucao(fimDaNoite, "en", "America/Sao_Paulo"))).toBe("11/23/26, 10:30 PM");
  });
});
