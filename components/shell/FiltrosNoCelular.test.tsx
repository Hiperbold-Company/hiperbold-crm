// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FiltrosNoCelular } from "./FiltrosNoCelular";

function simular(celular: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: celular && q === "(max-width: 767px)",
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(cleanup);

describe("FiltrosNoCelular", () => {
  it("celular: botão Filtros (2), filtros só depois do clique", () => {
    simular(true);
    render(
      <FiltrosNoCelular ativos={2}>
        <button>Filtro A</button>
      </FiltrosNoCelular>,
    );
    expect(screen.getByRole("button", { name: /Filtros \(2\)/ })).toBeTruthy();
    expect(screen.queryByText("Filtro A")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Filtros \(2\)/ }));
    expect(screen.getByText("Filtro A")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver resultados" }));
    expect(screen.queryByText("Filtro A")).toBeNull();
  });

  it("desktop: filtros direto e nenhum botão Filtros", () => {
    simular(false);
    render(
      <FiltrosNoCelular ativos={2}>
        <button>Filtro A</button>
      </FiltrosNoCelular>,
    );
    expect(screen.getByText("Filtro A")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Filtros/ })).toBeNull();
  });
});
