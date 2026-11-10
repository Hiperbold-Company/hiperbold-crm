/**
 * O laço rápido das automações (lote 6): ritmo, desligamento e resistência a
 * falha. A exclusão mútua com o cron é do BANCO (o lease em `claimed_until`) e
 * é provada contra Postgres em
 * `tests/invariants/automacao-claim-do-laco-rapido.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { TickSummary } from "@/lib/followup/engine";

import {
  criarSondaDeTrabalhoDasAutomacoes,
  dormirAbortavel,
  INTERVALO_COM_FALHA_MS,
  rodarLacoDasAutomacoes,
  SQL_DA_SONDA_DAS_AUTOMACOES,
} from "./runner";

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

  it("um tick que explode não derruba o laço: recua para 60 s e loga no máximo 1 vez por minuto", async () => {
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
    expect(sonecas).toEqual([INTERVALO_COM_FALHA_MS, INTERVALO_COM_FALHA_MS]);
    // Relógio parado: os dois erros caem na mesma janela de 1 minuto.
    expect(l.linhas.filter((x) => x.startsWith("error:"))).toHaveLength(1);
  });

  it("claim que falha recua para 60 s e o primeiro claim bom devolve o ritmo de 5 s", async () => {
    const ac = new AbortController();
    const sonecas: number[] = [];
    let t = 0;
    let ticks = 0;
    await rodarLacoDasAutomacoes(
      { intervalMs: 5000 },
      {
        tick: async () => {
          ticks++;
          return ticks <= 3 ? { ...VAZIO, claim_falhou: true } : { ...VAZIO, claimed: 1 };
        },
        agora: () => t,
        dormir: async (ms) => {
          sonecas.push(ms);
          t += ms;
          if (sonecas.length === 5) ac.abort();
        },
      },
      log(),
      ac.signal,
    );
    expect(sonecas).toEqual([60_000, 60_000, 60_000, 5000, 5000]);
  });

  it("falha repetida loga uma vez por minuto, não a cada tick", async () => {
    const ac = new AbortController();
    const l = log();
    let t = 0;
    await rodarLacoDasAutomacoes(
      { intervalMs: 5000 },
      {
        tick: async () => ({ ...VAZIO, claim_falhou: true }),
        agora: () => t,
        dormir: async (ms) => {
          t += ms; // 60 s por volta: uma linha por volta, nunca duas
          if (t >= 4 * 60_000) ac.abort();
        },
      },
      l,
      ac.signal,
    );
    expect(l.linhas.filter((x) => x.startsWith("error:"))).toHaveLength(4);
  });

  it("tick preso passa do teto, é registrado e o laço segue", async () => {
    const ac = new AbortController();
    const l = log();
    let ticks = 0;
    await rodarLacoDasAutomacoes(
      { intervalMs: 5000, tetoDoTickMs: 20 },
      {
        tick: () => {
          ticks++;
          return ticks === 1 ? new Promise<TickSummary>(() => {}) : Promise.resolve(VAZIO);
        },
        dormir: async () => {
          if (ticks === 2) ac.abort();
        },
      },
      l,
      ac.signal,
    );
    expect(ticks).toBe(2);
    expect(l.linhas.some((x) => x.includes("preso"))).toBe(true);
  });

  it("sinal de desligamento durante a sonda: o tick não começa", async () => {
    const ac = new AbortController();
    let ticks = 0;
    await rodarLacoDasAutomacoes(
      { intervalMs: 5000 },
      {
        temTrabalho: async () => {
          ac.abort();
          return true;
        },
        tick: async () => (ticks++, VAZIO),
        dormir: async () => {},
      },
      log(),
      ac.signal,
    );
    expect(ticks).toBe(0);
  });

  it("piso ocioso: sem trabalho a sonda segura o tick; com trabalho (ou sonda quebrada) o tick roda", async () => {
    const ac = new AbortController();
    const respostas: Array<boolean | "erro"> = [false, false, true, "erro"];
    let i = 0;
    let ticks = 0;
    const l = log();
    await rodarLacoDasAutomacoes(
      { intervalMs: 5000 },
      {
        temTrabalho: async () => {
          const r = respostas[i++]!;
          if (r === "erro") throw new Error("banco mudo");
          return r;
        },
        tick: async () => (ticks++, VAZIO),
        dormir: async () => {
          if (i === respostas.length) ac.abort();
        },
      },
      l,
      ac.signal,
    );
    expect(ticks).toBe(2); // o 3º (true) e o 4º (sonda quebrada: na dúvida, roda)
    expect(l.linhas.filter((x) => x.includes("sonda"))).toHaveLength(1);
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

describe("criarSondaDeTrabalhoDasAutomacoes", () => {
  it("consulta só a raia automacao e devolve o booleano; resposta vazia = roda", async () => {
    const consultas: string[] = [];
    const pool = (tem: unknown) => ({
      query: async (sql: string) => (consultas.push(sql), { rows: tem === undefined ? [] : [{ tem }] }),
    });
    expect(await criarSondaDeTrabalhoDasAutomacoes(pool(false) as never)()).toBe(false);
    expect(await criarSondaDeTrabalhoDasAutomacoes(pool(true) as never)()).toBe(true);
    expect(await criarSondaDeTrabalhoDasAutomacoes(pool(undefined) as never)()).toBe(true);
    expect(consultas[0]).toBe(SQL_DA_SONDA_DAS_AUTOMACOES);
    expect(SQL_DA_SONDA_DAS_AUTOMACOES).toContain("e.lane = 'automacao'");
  });
});
