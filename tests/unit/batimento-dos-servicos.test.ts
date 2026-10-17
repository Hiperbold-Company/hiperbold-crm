import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { rodarLoopDaFila } from "@/lib/agent-engine/queue/loop";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import {
  avaliarBatimento,
  criarBatedor,
  gravarBatimentoPg,
  LIMITE_DE_IDADE_SEGUNDOS,
} from "@/lib/system/batimento";

/**
 * Batimento dos serviços de fundo (migration 0961).
 *
 * O ponto que importa: o do worker está amarrado à VOLTA do laço da fila. Um
 * `setInterval` próprio continuaria batendo com o laço travado e o monitor
 * externo veria "vivo" um worker que não consome nada. O teste do laço abaixo
 * dirige `rodarLoopDaFila` de verdade e prova as duas metades: gira, bate; trava,
 * deixa de bater.
 */

const AGORA = Date.parse("2026-10-17T12:00:00.000Z");
const ha = (segundos: number) => new Date(AGORA - segundos * 1000).toISOString();

describe("avaliarBatimento", () => {
  it("batimento recente é ok, com a idade em segundos", () => {
    expect(avaliarBatimento("worker", ha(12), AGORA)).toEqual({
      status: "ok",
      ultimo_batimento_em: ha(12),
      segundos_desde: 12,
    });
  });

  it("no limite exato (180 s) ainda é ok; um segundo a mais é down", () => {
    expect(LIMITE_DE_IDADE_SEGUNDOS.worker).toBe(180);
    expect(LIMITE_DE_IDADE_SEGUNDOS.scheduler).toBe(180);
    expect(avaliarBatimento("worker", ha(180), AGORA).status).toBe("ok");
    expect(avaliarBatimento("scheduler", ha(181), AGORA)).toMatchObject({
      status: "down",
      motivo: "batimento_atrasado",
      segundos_desde: 181,
    });
  });

  it("sem linha (null/undefined/lixo) é down por falta de batimento", () => {
    for (const v of [null, undefined, "nao-e-data"]) {
      expect(avaliarBatimento("worker", v, AGORA)).toEqual({
        status: "down",
        ultimo_batimento_em: null,
        segundos_desde: null,
        motivo: "sem_batimento",
      });
    }
  });

  it("relógio adiantado (batimento no futuro) não gera idade negativa", () => {
    expect(avaliarBatimento("worker", ha(-30), AGORA)).toMatchObject({ status: "ok", segundos_desde: 0 });
  });
});

describe("criarBatedor", () => {
  it("grava no máximo uma vez por intervalo, por mais que o laço o chame", async () => {
    let t = 0;
    const gravar = vi.fn(async () => undefined);
    const { tocar } = criarBatedor({ gravar, intervaloMs: 30_000, agora: () => t });
    for (t = 0; t < 29_000; t += 2_000) tocar();
    expect(gravar).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0)); // a escrita termina
    t = 30_000;
    tocar();
    expect(gravar).toHaveBeenCalledTimes(2);
  });

  it("falha de escrita vai ao aoFalhar, não lança, e a tentativa seguinte é daqui a um intervalo", async () => {
    let t = 0;
    const aoFalhar = vi.fn();
    const gravar = vi.fn(async () => {
      throw new Error("banco fora");
    });
    const { tocar } = criarBatedor({ gravar, aoFalhar, intervaloMs: 30_000, agora: () => t });
    expect(() => tocar()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(aoFalhar).toHaveBeenCalledTimes(1);
    t = 5_000;
    tocar();
    expect(gravar).toHaveBeenCalledTimes(1);
    t = 30_000;
    tocar();
    expect(gravar).toHaveBeenCalledTimes(2);
  });

  it("gravar que lança de forma síncrona também é tratado", () => {
    const aoFalhar = vi.fn();
    const { tocar } = criarBatedor({
      gravar: () => {
        throw new Error("sincrono");
      },
      aoFalhar,
    });
    expect(() => tocar()).not.toThrow();
    expect(aoFalhar).toHaveBeenCalledTimes(1);
  });

  it("escrita pendurada não abre uma segunda em paralelo, mas não trava o batedor para sempre", () => {
    let t = 0;
    const gravar = vi.fn(() => new Promise<void>(() => undefined));
    const { tocar } = criarBatedor({ gravar, intervaloMs: 30_000, agora: () => t });
    tocar();
    t = 30_000;
    tocar(); // intervalo venceu, mas a primeira ainda está em voo há só 1 intervalo
    expect(gravar).toHaveBeenCalledTimes(1);
    t = 60_000;
    tocar(); // pendurada há 2 intervalos: nova tentativa
    expect(gravar).toHaveBeenCalledTimes(2);
  });
});

describe("gravarBatimentoPg", () => {
  it("é um upsert por serviço, com a hora do BANCO (now()), sem interpolar valores no texto", async () => {
    const query = vi.fn(async () => ({}));
    await gravarBatimentoPg({ query }, "worker", "1.2.3", { uptime_s: 5 });
    const [texto, valores] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(texto).toMatch(/insert into public\.sistema_batimentos/);
    expect(texto).toMatch(/on conflict \(servico\) do update/);
    expect(texto).toMatch(/values \(\$1, now\(\), \$2, \$3::jsonb\)/);
    expect(texto).not.toContain("1.2.3");
    expect(valores).toEqual(["worker", "1.2.3", JSON.stringify({ uptime_s: 5 })]);
  });
});

function logSpy(): Logger {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop } as unknown as Logger;
}

describe("o batimento do worker está amarrado à volta do laço da fila", () => {
  it("cada volta do laço chama aoCadaVolta; o batedor grava no ritmo dele, não no da volta", async () => {
    let voltas = 0;
    let t = 0;
    const gravar = vi.fn(async () => undefined);
    const { tocar } = criarBatedor({ gravar, intervaloMs: 30_000, agora: () => t });
    await rodarLoopDaFila<never>({
      relogio: async () => null,
      claimar: async () => [],
      aoClaimar: () => void voltas++,
      dormir: async (ms) => void (t += ms),
      deveParar: () => voltas >= 40,
      aoCadaVolta: tocar,
      intervalos: { ociosoMs: 2_000, retryMs: 250 },
      log: logSpy(),
    });
    // 40 voltas ociosas de 2 s = 80 s de relógio: 1 batida em t=0 e 1 em t=30 s e 1 em t=60 s.
    expect(voltas).toBe(40);
    expect(gravar).toHaveBeenCalledTimes(3);
  });

  it("laço TRAVADO no claim deixa de bater, mesmo com o relógio andando", async () => {
    let t = 0;
    const gravar = vi.fn(async () => undefined);
    const { tocar } = criarBatedor({ gravar, intervaloMs: 30_000, agora: () => t });
    // O claim nunca volta: a segunda volta jamais acontece.
    void rodarLoopDaFila<never>({
      relogio: async () => null,
      claimar: () => new Promise<never[]>(() => undefined),
      aoClaimar: () => undefined,
      dormir: async () => undefined,
      deveParar: () => false,
      aoCadaVolta: tocar,
      intervalos: { ociosoMs: 2_000, retryMs: 250 },
      log: logSpy(),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(gravar).toHaveBeenCalledTimes(1); // a primeira volta bateu
    t = 600_000; // dez minutos depois, sem nenhuma volta nova
    await new Promise((r) => setTimeout(r, 0));
    expect(gravar).toHaveBeenCalledTimes(1);
  });

  it("aoCadaVolta que lança não derruba o consumo da fila", async () => {
    let voltas = 0;
    await rodarLoopDaFila<never>({
      relogio: async () => null,
      claimar: async () => [],
      aoClaimar: () => void voltas++,
      dormir: async () => undefined,
      deveParar: () => voltas >= 3,
      aoCadaVolta: () => {
        throw new Error("batimento quebrado");
      },
      intervalos: { ociosoMs: 2_000, retryMs: 250 },
      log: logSpy(),
    });
    expect(voltas).toBe(3);
  });

  it("o main do worker liga o batedor ao laço (cerca contra trocar por setInterval)", () => {
    const fonte = readFileSync(resolve(__dirname, "../../workers/agent-worker/main.ts"), "utf8");
    expect(fonte).toMatch(/aoCadaVolta:\s*batimento\.tocar/);
    expect(fonte).toMatch(/gravarBatimentoPg\(pool,\s*"worker"/);
    // Nenhum timer próprio do batimento: os dois setInterval do arquivo são o reaper e os holds.
    expect(fonte.match(/setInterval\(/g)?.length).toBe(2);
  });
});

describe("o scheduler tem uma rota de cron por minuto que carrega o batimento", () => {
  it("event-log-drain está no crontab a cada minuto e a rota registra o batimento depois da autorização", () => {
    const cron = readFileSync(resolve(__dirname, "../../docker/scheduler/entrypoint.sh"), "utf8");
    expect(cron).toMatch(/^\* \* \* \* \*\|\d+\|api\/v1\/cron\/event-log-drain$/m);
    const rota = readFileSync(resolve(__dirname, "../../app/api/v1/cron/event-log-drain/route.ts"), "utf8");
    const iAuth = rota.indexOf("autorizaCron(req)");
    const iBate = rota.indexOf("registrarBatimentoDoScheduler()");
    expect(iAuth).toBeGreaterThan(-1);
    expect(iBate).toBeGreaterThan(iAuth);
  });
});
