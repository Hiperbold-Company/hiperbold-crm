/**
 * O laço rápido das automações (lote 6): ritmo, desligamento e resistência a
 * falha. A exclusão mútua com o cron é do BANCO (o lease em `claimed_until`) e
 * é provada contra Postgres em
 * `tests/invariants/automacao-claim-do-laco-rapido.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { TickSummary } from "@/lib/followup/engine";

import { dormirAbortavel, rodarLacoDasAutomacoes } from "./runner";

const VAZIO: TickSummary = { claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 };
const log = () => {
  const linhas: string[] = [];
  return {
    linhas,
    info: (m: string) => linhas.push(`info:${m}`),
    error: (m: string) => linhas.push(`error:${m}`),
  };
};

describe("rodarLacoDasAutomacoes", () => {
  it("chama o tick a cada intervalo, dorme o intervalo pedido e para no abort", async () => {
    const ac = new AbortController();
    const sonecas: number[] = [];
    let ticks = 0;
    await rodarLacoDasAutomacoes(
      { intervalMs: 5000 },
      {
        tick: async () => {
          ticks++;
          return { ...VAZIO, claimed: ticks === 1 ? 2 : 0 };
        },
        dormir: async (ms) => {
          sonecas.push(ms);
          if (sonecas.length === 3) ac.abort();
        },
      },
      log(),
      ac.signal,
    );
    expect(ticks).toBe(3);
    expect(sonecas).toEqual([5000, 5000, 5000]);
  });

  it("um tick que explode não derruba o laço nem o acelera", async () => {
    const ac = new AbortController();
    const l = log();
    const sonecas: number[] = [];
    let ticks = 0;
    await rodarLacoDasAutomacoes(
      { intervalMs: 5000 },
      {
        tick: async () => {
          ticks++;
          if (ticks === 1) throw new Error("banco fora do ar");
          return { ...VAZIO, claim_falhou: true };
        },
        dormir: async (ms) => {
          sonecas.push(ms);
          if (sonecas.length === 2) ac.abort();
        },
      },
      l,
      ac.signal,
    );
    expect(ticks).toBe(2);
    expect(sonecas).toEqual([5000, 5000]);
    expect(l.linhas.filter((x) => x.startsWith("error:"))).toHaveLength(2);
  });

  it("intervalo 0 desliga: o tick nunca roda (o cron de 1 min segue de piso)", async () => {
    let ticks = 0;
    await rodarLacoDasAutomacoes(
      { intervalMs: 0 },
      { tick: async () => (ticks++, VAZIO) },
      log(),
      new AbortController().signal,
    );
    expect(ticks).toBe(0);
  });
});

describe("dormirAbortavel", () => {
  it("o abort corta a soneca na hora", async () => {
    const ac = new AbortController();
    const inicio = Date.now();
    const p = dormirAbortavel(60_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - inicio).toBeLessThan(1000);
  });
});
