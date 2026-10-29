/**
 * "Eventos manuais" na barra do quadro é um BOTÃO com dropdown, no padrão dos
 * outros filtros. O que muda é só a apresentação: o valor entregue ao filtro
 * (e à URL) é o mesmo `{ op, n }` de antes.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FiltroDeEventosManuaisPopover } from "@/components/kanban/FiltroDeEventosManuaisPopover";
import { filtersFromParams, filtersToParams, type LeadFilters } from "@/lib/kanban/filters";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

afterEach(cleanup);

function Caixa({ inicial }: { inicial?: LeadFilters["manualEvents"] }) {
  const [v, setV] = useState<LeadFilters["manualEvents"]>(inicial);
  return (
    <>
      <FiltroDeEventosManuaisPopover valor={v} onChange={setV} />
      <output data-testid="valor">{JSON.stringify(v ?? null)}</output>
    </>
  );
}
const valor = () => JSON.parse(screen.getByTestId("valor").textContent!);

describe("FiltroDeEventosManuaisPopover", () => {
  it("sem filtro, o botão mostra 'qualquer' e o dropdown abre com as três comparações", async () => {
    render(<Caixa />);
    const botao = screen.getByRole("button", { name: "Eventos manuais: qualquer" });
    expect(botao.className.split(" ")).not.toContain("bg-accent/10");
    // Fechado, a comparação não ocupa a barra.
    expect(screen.queryByLabelText("Quantidade de eventos manuais")).toBeNull();
    await userEvent.click(botao);
    for (const nome of ["maior que", "igual a", "menor que"]) {
      expect(screen.getByRole("button", { name: nome })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Quantidade de eventos manuais")).toBeDisabled();
  });

  it("'maior que' e 1 aplicam { op: gt, n: 1 }, o rótulo vira '> 1', e limpar volta ao sem filtro", async () => {
    render(<Caixa />);
    await userEvent.click(screen.getByRole("button", { name: /Eventos manuais/ }));
    await userEvent.click(screen.getByRole("button", { name: "maior que" }));
    // Como antes: escolher a comparação com o campo vazio aplica 0.
    expect(valor()).toEqual({ op: "gt", n: 0 });
    fireEvent.change(screen.getByLabelText("Quantidade de eventos manuais"), {
      target: { value: "1" },
    });
    expect(valor()).toEqual({ op: "gt", n: 1 });
    // Mesma serialização de URL de antes.
    const qs = filtersToParams({ manualEvents: valor() });
    expect(qs).toBe("eventos=gt%3A1");
    expect(filtersFromParams(new URLSearchParams(qs)).manualEvents).toEqual({ op: "gt", n: 1 });

    const ativo = screen.getByRole("button", { name: "Eventos manuais > 1" });
    expect(ativo.className.split(" ")).toContain("bg-accent/10");

    await userEvent.click(screen.getByRole("button", { name: "Limpar filtro" }));
    expect(valor()).toBeNull();
    expect(screen.getByRole("button", { name: "Eventos manuais: qualquer" })).toBeInTheDocument();
    expect(screen.getByLabelText("Quantidade de eventos manuais")).toHaveValue(null);
  });

  it("número inválido não chega ao filtro; '=' e '<' aparecem no rótulo", async () => {
    render(<Caixa inicial={{ op: "eq", n: 0 }} />);
    expect(screen.getByRole("button", { name: "Eventos manuais = 0" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Eventos manuais/ }));
    await userEvent.click(screen.getByRole("button", { name: "menor que" }));
    fireEvent.change(screen.getByLabelText("Quantidade de eventos manuais"), {
      target: { value: "" },
    });
    expect(valor()).toEqual({ op: "lt", n: 0 });
    fireEvent.change(screen.getByLabelText("Quantidade de eventos manuais"), {
      target: { value: "3" },
    });
    expect(screen.getByRole("button", { name: "Eventos manuais < 3" })).toBeInTheDocument();
  });
});
