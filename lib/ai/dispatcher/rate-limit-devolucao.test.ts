/**
 * DEVOLVER UMA VAGA (`devolverRateLimit`) — o par do `checkRateLimit` para quem reserva antes
 * do efeito e precisa desfazer quando o efeito não acontece (teto de convites por organização).
 *
 * O que se cobra é comportamento, nas duas trilhas do contador:
 *   - EM MEMÓRIA (Redis ausente/inalcançável): reservar até o teto, barrar, devolver, reservar de novo;
 *   - NO REDIS (fake com semântica de INCR/DECR/EXPIRE/GET de verdade): idem, mais a corrida —
 *     N reservas simultâneas concedem no máximo o teto, que é o defeito que "ler antes, gastar
 *     depois" tinha.
 * E os limites da primitiva: nunca fica negativa, devolve na janela em que a vaga foi tomada, e
 * falha de Redis na devolução não lança.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Redis de mentira com a semântica que importa: contadores inteiros por chave, decr abaixo de 0 existe. */
const dados = new Map<string, number>();
const expira: string[] = [];
let redisFora = false;
let comRedis = true;

vi.mock("@upstash/redis", () => ({
  Redis: class {
    async incr(k: string) {
      if (redisFora) throw new Error("fetch failed");
      const v = (dados.get(k) ?? 0) + 1;
      dados.set(k, v);
      return v;
    }
    async decr(k: string) {
      if (redisFora) throw new Error("fetch failed");
      const v = (dados.get(k) ?? 0) - 1;
      dados.set(k, v);
      return v;
    }
    async expire(k: string) {
      expira.push(k);
      return 1;
    }
    async get(k: string) {
      return dados.get(k) ?? null;
    }
  },
}));

vi.mock("@/lib/env", () => ({
  get env() {
    return comRedis
      ? { UPSTASH_REDIS_REST_URL: "https://redis-de-teste.example", UPSTASH_REDIS_REST_TOKEN: "token-de-teste" }
      : {};
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  dados.clear();
  expira.length = 0;
  redisFora = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  ["em memória (sem Redis)", false],
  ["no Redis", true],
])("devolverRateLimit %s", (_nome, redis) => {
  beforeEach(() => {
    comRedis = redis;
  });

  it("devolver uma vaga CONCEDIDA abre exatamente uma; a tentativa barrada, devolvida, não abre nada", async () => {
    const { checkRateLimit, devolverRateLimit } = await import("./rate-limit");
    const vistos: boolean[] = [];
    for (let i = 0; i < 4; i++) vistos.push((await checkRateLimit("b:cheio", 3, 3600)).allowed);
    expect(vistos).toEqual([true, true, true, false]);

    // a 4ª (barrada) também incrementou o contador: quem a barrou devolve o que incrementou
    await devolverRateLimit("b:cheio", 3600);
    // a vaga real continua cheia: a próxima reserva barra (e devolve a própria tentativa)
    const barrada = await checkRateLimit("b:cheio", 3, 3600);
    expect(barrada.allowed).toBe(false);
    await devolverRateLimit("b:cheio", 3600);

    // devolve uma vaga CONCEDIDA (o convite falhou): abre exatamente uma
    await devolverRateLimit("b:cheio", 3600);
    const reaberta = await checkRateLimit("b:cheio", 3, 3600);
    expect(reaberta.allowed).toBe(true);
    const seguinte = await checkRateLimit("b:cheio", 3, 3600);
    expect(seguinte.allowed).toBe(false);
  });

  it("nunca fica negativo: devolver sem nada reservado não cria vaga extra", async () => {
    const { checkRateLimit, devolverRateLimit } = await import("./rate-limit");
    await devolverRateLimit("b:vazio", 3600);
    await devolverRateLimit("b:vazio", 3600);
    const vistos: boolean[] = [];
    for (let i = 0; i < 3; i++) vistos.push((await checkRateLimit("b:vazio", 2, 3600)).allowed);
    // limite 2: dois passam, o terceiro barra — as devoluções sobrando não deram crédito
    expect(vistos).toEqual([true, true, false]);
  });

  it("devolve na janela em que a vaga foi tomada, não na corrente", async () => {
    const { checkRateLimit, devolverRateLimit } = await import("./rate-limit");
    const antiga = await checkRateLimit("b:janela", 1, 60);
    expect(antiga.window_start).toBeTypeOf("number");

    vi.advanceTimersByTime(60_000); // a janela virou
    expect((await checkRateLimit("b:janela", 1, 60)).allowed).toBe(true); // vaga da janela nova

    await devolverRateLimit("b:janela", 60, antiga.window_start); // devolução da janela ANTIGA
    // a janela nova segue cheia: a devolução atrasada não a debitou
    expect((await checkRateLimit("b:janela", 1, 60)).allowed).toBe(false);
  });

  it("corrida: 40 reservas simultâneas concedem no máximo o teto (20); devolvidas as que falharam, a vaga volta", async () => {
    const { checkRateLimit, devolverRateLimit } = await import("./rate-limit");
    const reservas = await Promise.all(Array.from({ length: 40 }, () => checkRateLimit("b:corrida", 20, 3600)));
    const concedidas = reservas.filter((r) => r.allowed);
    expect(concedidas).toHaveLength(20);

    // 5 dos concedidos falharam e devolvem; os 20 barrados também devolvem o que incrementaram
    await Promise.all([
      ...concedidas.slice(0, 5).map((r) => devolverRateLimit("b:corrida", 3600, r.window_start)),
      ...reservas.filter((r) => !r.allowed).map((r) => devolverRateLimit("b:corrida", 3600, r.window_start)),
    ]);
    const depois = await Promise.all(Array.from({ length: 10 }, () => checkRateLimit("b:corrida", 20, 3600)));
    expect(depois.filter((r) => r.allowed)).toHaveLength(5); // exatamente as 5 devolvidas
  });
});

describe("devolverRateLimit no Redis: bordas", () => {
  beforeEach(() => {
    comRedis = true;
  });

  it("DECR abaixo de zero é desfeito e a chave nasce com expiração (não vaza para sempre)", async () => {
    const { devolverRateLimit } = await import("./rate-limit");
    const janela = Math.floor(Date.now() / 3_600_000);
    await devolverRateLimit("b:ausente", 3600);
    expect(dados.get(`b:ausente:${janela}`)).toBe(0);
    expect(expira).toContain(`b:ausente:${janela}`);
  });

  it("Redis fora na devolução: não lança, e cai para a memória como o incremento", async () => {
    const { checkRateLimit, devolverRateLimit } = await import("./rate-limit");
    redisFora = true;
    expect((await checkRateLimit("b:fora", 1, 3600)).allowed).toBe(true); // foi para a memória
    expect((await checkRateLimit("b:fora", 1, 3600)).allowed).toBe(false);
    await expect(devolverRateLimit("b:fora", 3600)).resolves.toBeUndefined();
    await devolverRateLimit("b:fora", 3600);
    expect((await checkRateLimit("b:fora", 1, 3600)).allowed).toBe(true); // a vaga voltou
  });
});
