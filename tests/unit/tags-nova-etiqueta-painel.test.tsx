/**
 * O botão "Nova etiqueta" da tela de Tags: abre o formulário, manda
 * `acao: "criar"` com nome e cor opcional, avisa e recarrega a lista.
 */
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { NovaEtiqueta } from "@/app/app/settings/tags/_nova-etiqueta";
import { PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";

const fetchMock = vi.fn();

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NovaEtiqueta idioma="pt-BR" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Nova etiqueta", () => {
  it("só habilita Criar com nome; envia nome e cor, avisa e recarrega", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { tag: "vip" } }), { status: 201 }));
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Nova etiqueta" }));
    const criar = screen.getByRole("button", { name: "Criar etiqueta" }) as HTMLButtonElement;
    expect(criar.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Nome da etiqueta"), { target: { value: "  VIP " } });
    fireEvent.click(screen.getAllByRole("button", { pressed: false }).find((b) => b.title === PALETA_DE_ETIQUETAS[0])!);
    expect(criar.disabled).toBe(false);
    fireEvent.click(criar);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Etiqueta criada."));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/tags/vocabulario");
    expect(JSON.parse(init.body)).toEqual({ acao: "criar", tag: "VIP", cor: PALETA_DE_ETIQUETAS[0] });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByLabelText("Nome da etiqueta")).toBeNull();
  });

  it("sem cor escolhida não manda o campo `cor`", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 201 }));
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Nova etiqueta" }));
    fireEvent.change(screen.getByLabelText("Nome da etiqueta"), { target: { value: "obra" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar etiqueta" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ acao: "criar", tag: "obra" });
  });

  it("etiqueta duplicada (409) mostra o aviso e mantém o formulário aberto", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "tag_ja_existe" } }), { status: 409 }),
    );
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Nova etiqueta" }));
    fireEvent.change(screen.getByLabelText("Nome da etiqueta"), { target: { value: "vip" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar etiqueta" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Essa etiqueta já existe."));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Nome da etiqueta")).toBeTruthy();
  });
});
