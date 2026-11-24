/**
 * O "Mais ações" do redesign (onda 3) só ESCONDE: o conteúdo segue montado, e
 * a lista fecha com Esc, com clique fora e ao escolher uma ação.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MaisAcoesRecolhidas } from "@/components/redesign/MaisAcoesRecolhidas";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

afterEach(cleanup);

function montar() {
  const aoClicar = vi.fn();
  const r = render(
    <div>
      <button type="button">fora</button>
      <MaisAcoesRecolhidas marca={{ "data-rd-chat": "mais-acoes" }} marcaDaLista={{ "data-rd-chat": "mais-acoes-lista" }}>
        <button type="button" onClick={aoClicar}>Arquivar</button>
        <span>texto</span>
      </MaisAcoesRecolhidas>
    </div>,
  );
  const details = r.container.querySelector("details") as HTMLDetailsElement;
  return { ...r, details, aoClicar };
}

describe("MaisAcoesRecolhidas", () => {
  it("fechado, o conteúdo continua montado e o gatilho tem nome", () => {
    const { details, getByText } = montar();
    expect(details.open).toBe(false);
    expect(getByText("Arquivar")).toBeInTheDocument();
    expect(details.querySelector("summary")).toHaveAttribute("aria-label", "Mais ações");
    expect(details).toHaveAttribute("data-rd-chat", "mais-acoes");
  });

  it("Esc fecha", () => {
    const { details } = montar();
    details.open = true;
    fireEvent.keyDown(details, { key: "Escape" });
    expect(details.open).toBe(false);
  });

  it("clique fora fecha; clique dentro, não", () => {
    const { details, getByText } = montar();
    details.open = true;
    fireEvent.pointerDown(getByText("texto"));
    expect(details.open).toBe(true);
    fireEvent.pointerDown(getByText("fora"));
    expect(details.open).toBe(false);
  });

  it("escolher uma ação fecha a lista e a ação roda", () => {
    const { details, getByText, aoClicar } = montar();
    details.open = true;
    fireEvent.click(getByText("Arquivar"));
    expect(aoClicar).toHaveBeenCalledTimes(1);
    expect(details.open).toBe(false);
  });
});
