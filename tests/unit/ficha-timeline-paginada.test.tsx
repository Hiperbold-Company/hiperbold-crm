import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { piorStatus, useLeadTimeline } from "@/hooks/leads/useLeadTimeline";

/**
 * A timeline da ficha PAGINA: a primeira página não é a história inteira, e o
 * evento retroativo recém-registrado pode cair muito além dela.
 */
const get = vi.fn();
const canais: Record<string, string> = {};
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: ({ name }: { name: string }) => ({
    status: canais[name.startsWith("timeline-contato") ? "contato" : "lead"] ?? "subscribed",
    ultimaEntrega: { current: null },
  }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => ({ divergencias: 0, ultimaDivergencia: null, ultimaVerificacao: null }),
}));

const LEAD = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

const it_ = (id: string) => ({ id, type: "note", performed_at: "2026-10-19T12:00:00Z" });

/** 3 páginas: p1 (a1,a2) → c1, p2 (b1) → c2, p3 (c1evento) fim. */
function tresPaginas() {
  get.mockImplementation(async (url: string) => {
    const cursor = new URL(url, "http://x").searchParams.get("cursor");
    if (!cursor) return { data: [it_("a1"), it_("a2")], meta: { has_more: true, cursor: "c1" } };
    if (cursor === "c1") return { data: [it_("b1")], meta: { has_more: true, cursor: "c2" } };
    return { data: [it_("antigo")], meta: { has_more: false, cursor: null } };
  });
}

function monta(contactId: string | null = CONTATO) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useLeadTimeline(LEAD, contactId), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(canais)) delete canais[k];
});
afterEach(cleanup);

describe("paginação da timeline da ficha", () => {
  it("busca a 1ª página com escopo=contato e avisa que há mais", async () => {
    tresPaginas();
    const { result } = monta();
    await waitFor(() => expect(result.current.itens).toHaveLength(2));
    expect(get.mock.calls[0]![0]).toContain("escopo=contato");
    expect(result.current.temMais).toBe(true);
  });

  it("carregarMais usa o cursor da página anterior e ACRESCENTA, sem trocar o que já está na tela", async () => {
    tresPaginas();
    const { result } = monta();
    await waitFor(() => expect(result.current.itens).toHaveLength(2));
    await act(async () => {
      await result.current.carregarMais();
    });
    expect(get.mock.calls[1]![0]).toContain("cursor=c1");
    await waitFor(() => expect(result.current.itens.map((i) => i.id)).toEqual(["a1", "a2", "b1"]));
    expect(result.current.temMais).toBe(true);
  });

  it("na última página 'temMais' vira falso", async () => {
    tresPaginas();
    const { result } = monta();
    await waitFor(() => expect(result.current.itens).toHaveLength(2));
    await act(async () => {
      await result.current.carregarMais();
    });
    await waitFor(() => expect(result.current.itens).toHaveLength(3));
    await act(async () => {
      await result.current.carregarMais();
    });
    await waitFor(() =>
      expect(result.current.itens.map((i) => i.id)).toEqual(["a1", "a2", "b1", "antigo"]),
    );
    expect(result.current.temMais).toBe(false);
  });

  it("revelarEvento pagina para trás até achar o evento retroativo", async () => {
    tresPaginas();
    const { result } = monta();
    await waitFor(() => expect(result.current.itens).toHaveLength(2));
    await act(async () => {
      await result.current.revelarEvento("antigo");
    });
    await waitFor(() => expect(result.current.itens.map((i) => i.id)).toContain("antigo"));
  });

  it("revelarEvento de um evento que já está na 1ª página não busca mais nada", async () => {
    tresPaginas();
    const { result } = monta();
    await waitFor(() => expect(result.current.itens).toHaveLength(2));
    await act(async () => {
      await result.current.revelarEvento("a1");
    });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("status do realtime = o pior dos canais", () => {
  it("piorStatus ordena por gravidade", () => {
    expect(piorStatus(["subscribed", "subscribed"])).toBe("subscribed");
    expect(piorStatus(["subscribed", "connecting"])).toBe("connecting");
    expect(piorStatus(["subscribed", "channel_error"])).toBe("channel_error");
    expect(piorStatus(["timed_out", "closed"])).toBe("timed_out");
  });

  it("canal do contato morto derruba o status, mesmo com o do negócio vivo", async () => {
    tresPaginas();
    canais.contato = "channel_error";
    const { result } = monta();
    await waitFor(() => expect(result.current.itens).toHaveLength(2));
    expect(result.current.realtimeStatus).toBe("channel_error");
  });

  it("sem contato o canal do contato nem conta (ele fica 'closed' de propósito)", async () => {
    tresPaginas();
    canais.contato = "closed";
    const { result } = monta(null);
    await waitFor(() => expect(result.current.itens).toHaveLength(2));
    expect(result.current.realtimeStatus).toBe("subscribed");
  });
});
