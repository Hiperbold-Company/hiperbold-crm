import { describe, expect, it } from "vitest";

import { LOTE_DOS_RELATOS, podarRelatosVencidos, type PodaDosRelatosDb } from "./retencao";

/** Um banco de mentira com relatos de várias idades; a poda real decide o corte. */
function banco(idadesEmDias: number[], agora: number, comPrint = true) {
  let linhas = idadesEmDias.map((d, i) => ({
    id: `r${i}`,
    created_at: new Date(agora - d * 86_400_000).toISOString(),
    screenshot_path: comPrint ? `org/r${i}.webp` : null,
  }));
  const removidos: string[] = [];
  const db: PodaDosRelatosDb = {
    async vencidos(antesDe, lote) {
      return {
        data: linhas.filter((l) => l.created_at < antesDe).slice(0, lote).map(({ id, screenshot_path }) => ({ id, screenshot_path })),
        error: null,
      };
    },
    async removerPrints(c) {
      removidos.push(...c);
      return { error: null };
    },
    async apagar(ids) {
      const antes = linhas.length;
      linhas = linhas.filter((l) => !ids.includes(l.id));
      return { data: antes - linhas.length, error: null };
    },
  };
  return { db, removidos, restantes: () => linhas.map((l) => l.id) };
}

describe("poda dos relatos de problema (90 dias)", () => {
  const agora = Date.parse("2026-11-17T12:00:00Z");

  it("apaga linha e print só do que passou de 90 dias", async () => {
    const b = banco([10, 89, 91, 400], agora);
    const r = await podarRelatosVencidos(b.db, agora);
    expect(r.relatos_apagados).toBe(2);
    expect(b.removidos.sort()).toEqual(["org/r2.webp", "org/r3.webp"]);
    expect(b.restantes()).toEqual(["r0", "r1"]);
  });

  it("nada vencido: zero e nenhuma chamada de remoção", async () => {
    const b = banco([1, 2], agora);
    const r = await podarRelatosVencidos(b.db, agora);
    expect(r).toMatchObject({ relatos_apagados: 0, prints_apagados: 0, lotes_relatos: 0 });
    expect(b.removidos).toEqual([]);
  });

  it("drena em lotes até esvaziar", async () => {
    const b = banco(Array.from({ length: LOTE_DOS_RELATOS + 5 }, () => 100), agora, false);
    const r = await podarRelatosVencidos(b.db, agora);
    expect(r.relatos_apagados).toBe(LOTE_DOS_RELATOS + 5);
    expect(r.lotes_relatos).toBe(2);
  });

  it("falha ao remover o print não apaga a linha (o arquivo não perde o ponteiro)", async () => {
    const b = banco([100], agora);
    b.db.removerPrints = async () => ({ error: { message: "storage fora" } });
    await expect(podarRelatosVencidos(b.db, agora)).rejects.toThrow(/bug_reports: storage fora/);
    expect(b.restantes()).toEqual(["r0"]);
  });
});
