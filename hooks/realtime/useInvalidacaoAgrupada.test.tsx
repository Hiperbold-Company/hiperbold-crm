/**
 * A invalidação agrupada contra um QueryClient de verdade: a rajada vira UM
 * GET por chave, e o que estava pendente ao desmontar não sai pela rede.
 *
 * SABOTAGEM: trocar `pedir` por `qc.invalidateQueries` direto = 10 buscas.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useInvalidacaoAgrupada } from "./useInvalidacaoAgrupada";

const OPCOES = { janelaMs: 300, tetoMs: 1000 };

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const buscar = vi.fn(async () => "ok");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const r = renderHook(
    () => {
      useQuery({ queryKey: ["messages", "c1"], queryFn: buscar });
      return useInvalidacaoAgrupada(OPCOES);
    },
    { wrapper },
  );
  return { qc, buscar, ...r };
}

describe("useInvalidacaoAgrupada", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rajada de 10 eventos vira 1 busca da query", async () => {
    const { buscar, result } = montar();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(buscar).toHaveBeenCalledTimes(1); // a carga inicial
    await act(async () => {
      for (let i = 0; i < 10; i++) result.current(["messages", "c1"]);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(buscar).toHaveBeenCalledTimes(2);
  });

  it("ao desmontar, o pendente só é marcado como velho: nenhuma busca sai", async () => {
    const { qc, buscar, result, unmount } = montar();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => result.current(["messages", "c1"]));
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(buscar).toHaveBeenCalledTimes(1);
    expect(qc.getQueryState(["messages", "c1"])?.isInvalidated).toBe(true);
  });
});
