import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EtiquetaDaConexao } from "./EtiquetaDaConexao";
import { RenomearConexao } from "./RenomearConexao";

describe("EtiquetaDaConexao", () => {
  it("sem cor: a aparência de antes (texto apagado, sem variáveis de cor)", () => {
    render(<EtiquetaDaConexao texto="WhatsApp" cor={null} />);
    const el = screen.getByText("WhatsApp").parentElement!;
    expect(el).toHaveClass("text-text-muted");
    expect(el).not.toHaveAttribute("data-cor-da-conexao");
    expect(el.getAttribute("style") ?? "").not.toContain("--etq-conexao-fundo");
  });

  it("com cor: pinta pela paleta, nos dois temas", () => {
    render(<EtiquetaDaConexao texto="Ingrid Müller" cor="rosa" />);
    const el = screen.getByText("Ingrid Müller").parentElement!;
    expect(el).toHaveAttribute("data-cor-da-conexao", "rosa");
    expect(el).not.toHaveClass("text-text-muted");
    expect(el.style.getPropertyValue("--etq-conexao-fundo")).toBe("#fce7f3");
    expect(el.style.getPropertyValue("--etq-conexao-texto")).toBe("#9d174d");
    expect(el.style.getPropertyValue("--etq-conexao-fundo-escuro")).toBe("#500724");
    expect(el.className).toContain("dark:text-[color:var(--etq-conexao-texto-escuro)]");
  });

  it("chave desconhecida vinda do servidor cai em sem cor, nunca em erro", () => {
    render(<EtiquetaDaConexao texto="X" cor="#ff0000" />);
    expect(screen.getByText("X").parentElement).toHaveClass("text-text-muted");
  });
});

describe("RenomearConexao com cor", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockReturnValue(
      Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  it("escolher a cor envia nome e chave da cor, e a prévia mostra a cor escolhida", async () => {
    const onSaved = vi.fn();
    render(
      <RenomearConexao
        channelId="c1"
        currentName="WhatsApp"
        comCor
        currentColor={null}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Editar nome e cor" }));
    expect(screen.getAllByRole("radio")).toHaveLength(13); // 12 cores + "Sem cor"
    expect(screen.getByRole("radio", { name: "Sem cor" })).toHaveAttribute("aria-checked", "true");

    fireEvent.change(screen.getByLabelText("Nome interno"), { target: { value: "Ingrid Müller" } });
    fireEvent.click(screen.getByRole("radio", { name: "Lavanda" }));
    expect(screen.getByRole("radio", { name: "Lavanda" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Ingrid Müller").parentElement).toHaveAttribute(
      "data-cor-da-conexao",
      "lavanda",
    );

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const chamada = fetchMock.mock.calls.at(-1);
    expect(String(chamada?.[0])).toContain("/api/v1/channel-sessions/c1/name");
    expect(JSON.parse(String((chamada?.[1] as RequestInit).body))).toEqual({
      display_name: "Ingrid Müller",
      label_color: "lavanda",
    });
  });

  it("tirar a cor envia label_color null", async () => {
    const onSaved = vi.fn();
    render(
      <RenomearConexao
        channelId="c1"
        currentName="Comercial"
        comCor
        currentColor="menta"
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Editar nome e cor" }));
    expect(screen.getByRole("radio", { name: "Menta" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Sem cor" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body))).toEqual({
      display_name: "Comercial",
      label_color: null,
    });
  });
});
