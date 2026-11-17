import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RelatarProblema } from "./RelatarProblema";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DESCRICAO = "A lista de contatos não carrega depois do filtro.";

let enviados: FormData[] = [];

beforeEach(() => {
  enviados = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      enviados.push(init?.body as FormData);
      return new Response(JSON.stringify({ data: { id: "x" } }), { status: 201 });
    }),
  );
  if (!URL.createObjectURL) {
    Object.assign(URL, { createObjectURL: () => "blob:fake", revokeObjectURL: () => undefined });
  }
});
afterEach(() => vi.unstubAllGlobals());

const printOk = async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });

async function abrirModal() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Relatar problema" }));
  });
  await screen.findByText("Relatar um problema");
}

describe("RelatarProblema", () => {
  it("a aba só aparece a partir de lg (hidden abaixo, lg:flex) e fica fora do print", () => {
    render(<RelatarProblema capturar={printOk} />);
    const aba = screen.getByRole("button", { name: "Relatar problema" });
    expect(aba.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "lg:flex", "fixed", "right-0"]));
    expect(aba.hasAttribute("data-fora-do-print")).toBe(true);
  });

  it("o modal exige descrição: não envia com texto curto", async () => {
    render(<RelatarProblema capturar={printOk} />);
    await abrirModal();
    fireEvent.change(screen.getByLabelText("Descreva o problema encontrado"), { target: { value: "curto" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    });
    expect(enviados).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("10 a 2000");
  });

  it("Sim (pré-selecionado) manda o print; o contexto vai sem o hash", async () => {
    window.history.pushState({}, "", "/app/contacts?aba=1#segredo");
    render(<RelatarProblema capturar={printOk} />);
    await abrirModal();
    expect((screen.getByLabelText("Sim") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Descreva o problema encontrado"), { target: { value: DESCRICAO } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    });
    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0]!.get("screenshot")).toBeInstanceOf(Blob);
    const contexto = JSON.parse(String(enviados[0]!.get("context"))) as { url: string };
    expect(contexto.url).toBe("/app/contacts?aba=1");
  });

  it("Não omite o print no envio", async () => {
    render(<RelatarProblema capturar={printOk} />);
    await abrirModal();
    fireEvent.click(screen.getByLabelText("Não"));
    fireEvent.change(screen.getByLabelText("Descreva o problema encontrado"), { target: { value: DESCRICAO } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    });
    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0]!.get("screenshot")).toBeNull();
    expect(enviados[0]!.get("description")).toBe(DESCRICAO);
  });

  it("falha na captura não quebra: o modal abre e o relato segue sem print", async () => {
    const falha = vi.fn(async () => {
      throw new Error("canvas tainted");
    });
    render(<RelatarProblema capturar={falha} />);
    await abrirModal();
    expect(falha).toHaveBeenCalled();
    expect(screen.queryByAltText("Print da tela")).toBeNull();
    fireEvent.change(screen.getByLabelText("Descreva o problema encontrado"), { target: { value: DESCRICAO } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    });
    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0]!.get("screenshot")).toBeNull();
  });
});
