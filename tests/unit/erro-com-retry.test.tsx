// @vitest-environment jsdom
/**
 * O estado de erro único das telas (Contatos, Automações, Origens): anuncia
 * como alerta, fala com leigo, refaz a busca e não deixa clicar duas vezes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ErroComRetry } from "@/components/empty/ErroComRetry";

afterEach(cleanup);

describe("ErroComRetry", () => {
  it("sem props: alerta com o texto padrão e sem botão", () => {
    render(<ErroComRetry />);
    const alerta = screen.getByRole("alert");
    expect(alerta.textContent).toContain("Não foi possível carregar");
    expect(alerta.textContent).toContain("Tente de novo em instantes");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("título e descrição próprios substituem os padrões", () => {
    render(<ErroComRetry titulo="Contatos fora do ar" descricao="Tente daqui a pouco." />);
    expect(screen.getByRole("heading", { name: "Contatos fora do ar" })).toBeTruthy();
    expect(screen.getByText("Tente daqui a pouco.")).toBeTruthy();
    expect(screen.queryByText("Não foi possível carregar")).toBeNull();
  });

  it("Tentar novamente chama onRetry", () => {
    const onRetry = vi.fn();
    render(<ErroComRetry onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("enquanto tenta de novo, o botão fica desabilitado", () => {
    const onRetry = vi.fn();
    render(<ErroComRetry onRetry={onRetry} tentando />);
    const botao = screen.getByRole("button", { name: "Tentar novamente" }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    fireEvent.click(botao);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("não expõe detalhe técnico do erro (nada de message nem digest)", () => {
    // A interface não recebe o objeto de erro: só texto pensado para leigo.
    render(<ErroComRetry />);
    expect(screen.getByRole("alert").textContent).not.toMatch(/error|digest|stack/i);
  });
});
