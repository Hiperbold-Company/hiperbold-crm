/**
 * A tela do filtro "Campo:" de Contatos com as condições novas: as sete na ordem, o Valor some em
 * "está vazio"/"não está vazio" (e o Aplicar vale só com o campo), "é qualquer um de" mostra a dica
 * da vírgula, e o botão descreve o filtro aplicado.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { FiltrosAvancadosDeContatos } from "@/components/contacts/FiltrosAvancadosDeContatos";
import { filtrosFromParams, filtrosToParams, type FiltrosDaTela, type MudancaDeTexto } from "@/lib/contacts/filtros-url";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

afterEach(cleanup);

/** A tela de verdade passa pela URL: a mudança vira query e volta como filtros. */
function Caixa({ inicial = {} }: { inicial?: FiltrosDaTela }) {
  const [f, setF] = useState<FiltrosDaTela>(inicial);
  const aplicar = (m: MudancaDeTexto) => {
    const proximo: Record<string, unknown> = { ...f };
    for (const [k, v] of Object.entries(m)) {
      if (v === undefined) delete proximo[k];
      else proximo[k] = v;
    }
    setF(filtrosFromParams(filtrosToParams(proximo as FiltrosDaTela)));
  };
  return (
    <>
      <FiltrosAvancadosDeContatos filtros={f} opcoes={undefined} onChange={aplicar} />
      <output data-testid="filtros">{JSON.stringify(f)}</output>
    </>
  );
}
const filtrosAplicados = () => JSON.parse(screen.getByTestId("filtros").textContent!) as FiltrosDaTela;

async function abrir() {
  await userEvent.click(screen.getByRole("button", { name: /^Campo:/ }));
}

describe("filtro Campo: as condições", () => {
  it("as sete condições, na ordem combinada", async () => {
    render(<Caixa />);
    await abrir();
    const opcoes = [...(screen.getByLabelText("Condição") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opcoes).toEqual([
      "contém",
      "não contém",
      "é igual a",
      "é diferente de",
      "é qualquer um de",
      "está vazio",
      "não está vazio",
    ]);
  });

  it("'está vazio' esconde o Valor, aplica só com o campo, e o botão diz '<campo> está vazio'", async () => {
    render(<Caixa />);
    await abrir();
    fireEvent.change(screen.getByLabelText("Campo"), { target: { value: "cargo" } });
    expect(screen.getByRole("button", { name: "Aplicar" })).toBeDisabled(); // "contém" sem valor
    fireEvent.change(screen.getByLabelText("Condição"), { target: { value: "vazio" } });
    expect(screen.queryByLabelText("Valor")).toBeNull();
    const aplicarBotao = screen.getByRole("button", { name: "Aplicar" });
    expect(aplicarBotao).toBeEnabled();
    await userEvent.click(aplicarBotao);
    expect(filtrosAplicados()).toEqual({ campo: "cargo", campo_op: "vazio", campo_escopo: "qualquer" });
    expect(screen.getByRole("button", { name: /^Campo:/ })).toHaveTextContent("Campo: cargo está vazio");
  });

  it("trocar de 'contém x' para 'não está vazio' não deixa o valor antigo no filtro", async () => {
    render(<Caixa inicial={{ campo: "cargo", campo_op: "contem", campo_valor: "dir", campo_escopo: "contato" }} />);
    expect(screen.getByRole("button", { name: /^Campo:/ })).toHaveTextContent("Campo: cargo contém dir (só do contato)");
    await abrir();
    fireEvent.change(screen.getByLabelText("Condição"), { target: { value: "preenchido" } });
    await userEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(filtrosAplicados()).toEqual({ campo: "cargo", campo_op: "preenchido", campo_escopo: "contato" });
    expect(screen.getByRole("button", { name: /^Campo:/ })).toHaveTextContent("Campo: cargo não está vazio (só do contato)");
  });

  it("'é qualquer um de' mostra a dica da vírgula e o botão lista os valores", async () => {
    render(<Caixa />);
    await abrir();
    fireEvent.change(screen.getByLabelText("Campo"), { target: { value: "cargo" } });
    fireEvent.change(screen.getByLabelText("Condição"), { target: { value: "qualquer_de" } });
    expect(screen.getByText("Separe os valores por vírgula.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Valor"), { target: { value: " A , B,, C " } });
    await userEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(screen.getByRole("button", { name: /^Campo:/ })).toHaveTextContent("Campo: cargo é um de: A, B, C");
  });

  it("'é qualquer um de' com mais de 20 valores não aplica e avisa", async () => {
    render(<Caixa />);
    await abrir();
    fireEvent.change(screen.getByLabelText("Campo"), { target: { value: "cargo" } });
    fireEvent.change(screen.getByLabelText("Condição"), { target: { value: "qualquer_de" } });
    fireEvent.change(screen.getByLabelText("Valor"), {
      target: { value: Array.from({ length: 21 }, (_, i) => `v${i}`).join(",") },
    });
    expect(screen.getByText("Use no máximo 20 valores.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aplicar" })).toBeDisabled();
  });

  it("'não contém' e 'é diferente de' descrevem o filtro no botão", () => {
    render(<Caixa inicial={{ campo: "cargo", campo_op: "nao_contem", campo_valor: "dir", campo_escopo: "negocio" }} />);
    expect(screen.getByRole("button", { name: /^Campo:/ })).toHaveTextContent("Campo: cargo não contém dir (só do negócio)");
    cleanup();
    render(<Caixa inicial={{ campo: "cargo", campo_op: "diferente", campo_valor: "Gerente", campo_escopo: "qualquer" }} />);
    expect(screen.getByRole("button", { name: /^Campo:/ })).toHaveTextContent("Campo: cargo é diferente de Gerente");
  });
});
