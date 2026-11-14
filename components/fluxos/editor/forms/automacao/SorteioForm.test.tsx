/**
 * O bloco "Sorteio" no editor: o painel do percentual, o card com as duas
 * saídas rotuladas e a caixa na paleta da automação (e só nela).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { nodeBranches } from "@/lib/followup/graph-schema";

import { NodePalette } from "../../NodePalette";
import { NodeCard } from "../../nodes/NodeCard";
import { describeNodeConfig, NODE_VISUALS } from "../../nodes/nodeVisuals";
import { SorteioForm } from "./SorteioForm";

vi.mock("../../EtapasDoFluxo", () => ({
  useEtapasDoFluxo: () => ({ etapas: [], carregando: false, falhou: false, nomes: {} }),
}));
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));

function digitar(valor: string) {
  fireEvent.change(screen.getByTestId("sorteio-percentual"), { target: { value: valor } });
}

describe("SorteioForm", () => {
  it("mostra o percentual da A e o resto da B; mudar grava o número", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ percent_a: 50 }} onChange={onChange} />);
    expect((screen.getByTestId("sorteio-percentual") as HTMLInputElement).value).toBe("50");
    expect(screen.getByTestId("sorteio-resumo").textContent).toBe("A (50%) · B (50%)");

    digitar("30");
    expect(onChange).toHaveBeenLastCalledWith({ percent_a: 30 });
    expect(screen.getByTestId("sorteio-resumo").textContent).toBe("A (30%) · B (70%)");
  });

  it.each(["0", "100", "", "12.5", "-3"])("valor %j não grava e avisa", (valor) => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ percent_a: 50 }} onChange={onChange} />);
    digitar(valor);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sorteio-erro").textContent).toContain("1 a 99");
    expect(screen.queryByTestId("sorteio-resumo")).toBeNull();
  });

  it("os limites 1 e 99 valem", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ percent_a: 50 }} onChange={onChange} />);
    digitar("1");
    expect(onChange).toHaveBeenLastCalledWith({ percent_a: 1 });
    digitar("99");
    expect(onChange).toHaveBeenLastCalledWith({ percent_a: 99 });
  });
});

describe("card e paleta do Sorteio", () => {
  it("nasce 50/50 e o card tem duas saídas rotuladas A (50%) e B (50%)", () => {
    const config = NODE_VISUALS.random_split.defaultConfig();
    expect(config).toEqual({ percent_a: 50 });
    render(
      <NodeCard
        id="s1"
        visual={NODE_VISUALS.random_split}
        label="Sorteio"
        subtitle={describeNodeConfig("random_split", config, (x) => x)}
        branches={nodeBranches({ type: "random_split", config: { percent_a: 50 } })}
      />,
    );
    expect(screen.getByTestId("node-branch-s1-a").textContent).toContain("A (50%)");
    expect(screen.getByTestId("node-branch-s1-b").textContent).toContain("B (50%)");
    expect(screen.getByText("A 50% · B 50%")).toBeTruthy();
  });

  it("a caixa está no menu de blocos da automação, em Lógica, e não no do follow-up", () => {
    const { unmount } = render(<NodePalette onAdd={() => {}} surface="automacao" />);
    expect(screen.getByTestId("palette-grupo-logica").querySelector('[data-testid="palette-add-random_split"]')).not.toBeNull();
    unmount();
    render(<NodePalette onAdd={() => {}} surface="followup" />);
    expect(screen.queryByTestId("palette-add-random_split")).toBeNull();
  });
});
