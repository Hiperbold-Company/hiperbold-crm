// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AcoesNoCelular } from "./AcoesNoCelular";

function simular(celular: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: celular && q === "(max-width: 767px)",
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(cleanup);

describe("AcoesNoCelular", () => {
  it("celular: só o ⋯, e a ação roda ao escolher no menu", async () => {
    simular(true);
    const importar = vi.fn();
    render(
      <AcoesNoCelular acoes={[{ rotulo: "Importar", onSelect: importar }]}>
        <button>Importar</button>
      </AcoesNoCelular>,
    );
    expect(screen.queryByText("Importar")).toBeNull();
    const gatilho = screen.getByRole("button", { name: "Mais ações" });
    fireEvent.pointerDown(gatilho, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(gatilho);
    const item = await screen.findByRole("menuitem", { name: "Importar" });
    fireEvent.click(item);
    expect(importar).toHaveBeenCalledTimes(1);
  });

  it("desktop: os botões como estão e nenhum ⋯", () => {
    simular(false);
    render(
      <AcoesNoCelular acoes={[{ rotulo: "Importar" }]}>
        <button>Importar</button>
      </AcoesNoCelular>,
    );
    expect(screen.getByRole("button", { name: "Importar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mais ações" })).toBeNull();
  });
});
