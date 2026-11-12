/**
 * O agrupador de rajadas do Realtime (11/11/2026: o Supabase respondeu 429 e
 * cada evento do Chat virava um GET).
 *
 * SABOTAGEM: trocar o corpo de `pedir` por `executar(carga)` = rajada vira N
 * execuções; tirar o `Math.min` do teto = rajada contínua nunca executa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { criarAgrupador } from "./coalescer";

describe("criarAgrupador", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rajada de 10 eventos na mesma chave vira 1 execução, depois da janela", () => {
    const executar = vi.fn();
    const a = criarAgrupador({ janelaMs: 300, tetoMs: 1000 }, executar);
    for (let i = 0; i < 10; i++) {
      a.pedir("k", i);
      vi.advanceTimersByTime(20);
    }
    expect(executar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(executar).toHaveBeenCalledTimes(1);
    expect(executar).toHaveBeenLastCalledWith(9);
    vi.advanceTimersByTime(5000);
    expect(executar).toHaveBeenCalledTimes(1);
  });

  it("chaves diferentes não se misturam: 1 execução por chave", () => {
    const executar = vi.fn();
    const a = criarAgrupador({ janelaMs: 300, tetoMs: 1000 }, executar);
    for (let i = 0; i < 5; i++) {
      a.pedir("a", "a");
      a.pedir("b", "b");
    }
    vi.advanceTimersByTime(300);
    expect(executar.mock.calls.map(([c]) => c).sort()).toEqual(["a", "b"]);
  });

  it("respeita o teto: rajada contínua executa no máximo tetoMs depois do primeiro evento", () => {
    const executar = vi.fn();
    const a = criarAgrupador({ janelaMs: 300, tetoMs: 1000 }, executar);
    // Um evento a cada 100 ms por 3 s: o debounce puro nunca dispararia.
    for (let t = 0; t < 3000; t += 100) {
      a.pedir("k", t);
      vi.advanceTimersByTime(100);
    }
    // ~3 execuções em 3 s (uma por teto), nunca 30 e nunca zero.
    expect(executar.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(executar.mock.calls.length).toBeLessThanOrEqual(3);
    expect(executar.mock.calls[0]![0]).toBeLessThanOrEqual(1000);
  });

  it("imediato: o primeiro evento executa na hora e o resto da rajada vira UMA execução", () => {
    const executar = vi.fn();
    const a = criarAgrupador({ janelaMs: 300, tetoMs: 1000, imediato: true }, executar);
    a.pedir("k", 0);
    expect(executar).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 10; i++) {
      vi.advanceTimersByTime(30);
      a.pedir("k", i);
    }
    expect(executar).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(executar).toHaveBeenCalledTimes(2);
    expect(executar).toHaveBeenLastCalledWith(9);
    // Rajada encerrada e resfriamento vencido: o próximo evento volta a sair na hora.
    vi.advanceTimersByTime(300);
    a.pedir("k", 99);
    expect(executar).toHaveBeenCalledTimes(3);
  });

  it("imediato com um evento só: não executa de novo no fim da janela", () => {
    const executar = vi.fn();
    const a = criarAgrupador({ janelaMs: 300, tetoMs: 1000, imediato: true }, executar);
    a.pedir("k", 1);
    vi.advanceTimersByTime(2000);
    expect(executar).toHaveBeenCalledTimes(1);
  });

  it("encerrar cancela os timers e devolve só o que estava pendente", () => {
    const executar = vi.fn();
    const a = criarAgrupador({ janelaMs: 300, tetoMs: 1000 }, executar);
    a.pedir("a", "a");
    a.pedir("b", "b");
    expect(a.encerrar().sort()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(5000);
    expect(executar).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
