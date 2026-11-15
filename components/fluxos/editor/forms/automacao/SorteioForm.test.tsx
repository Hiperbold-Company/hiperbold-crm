/**
 * O bloco "Sorteio" no editor: o painel das saídas e pesos (A/B legado e
 * ponderado de até 10), o card com as saídas rotuladas e a caixa na paleta da
 * automação (e só nela).
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

const peso = (letra: string, valor: string) =>
  fireEvent.change(screen.getByTestId(`sorteio-peso-${letra}`), { target: { value: valor } });
const valorDe = (id: string) => (screen.getByTestId(id) as HTMLInputElement).value;

describe("SorteioForm", () => {
  it("abre a config legada {percent_a: 30} como A=30 e B=70", () => {
    render(<SorteioForm config={{ percent_a: 30 }} onChange={vi.fn()} />);
    expect(valorDe("sorteio-peso-A")).toBe("30");
    expect(valorDe("sorteio-peso-B")).toBe("70");
    expect(screen.queryByTestId("sorteio-saida-C")).toBeNull();
    expect(screen.getByTestId("sorteio-resumo").textContent).toBe("Soma dos pesos: 100%");
    expect(screen.queryByTestId("sorteio-erro")).toBeNull();
  });

  it("abre a config ponderada com os pesos e os nomes de cada saída", () => {
    render(
      <SorteioForm
        config={{ ramos: [{ peso: 60, nome: "Kyla" }, { peso: 30 }, { peso: 10, nome: "Reserva" }] }}
        onChange={vi.fn()}
      />,
    );
    expect(valorDe("sorteio-peso-A")).toBe("60");
    expect(valorDe("sorteio-nome-A")).toBe("Kyla");
    expect(valorDe("sorteio-nome-B")).toBe("");
    expect(valorDe("sorteio-peso-C")).toBe("10");
    expect(valorDe("sorteio-nome-C")).toBe("Reserva");
  });

  it("editar os pesos até somar 100 grava a config nova {ramos}", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ ramos: [{ peso: 50 }, { peso: 50 }] }} onChange={onChange} />);
    // 20 + 50 = 70: não fecha, nada é gravado e a soma aparece.
    peso("A", "20");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sorteio-resumo").textContent).toBe("Soma dos pesos: 70%");
    // 20 + 80 = 100: grava.
    peso("B", "80");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ ramos: [{ peso: 20 }, { peso: 80 }] });
    expect(screen.queryByTestId("sorteio-erro")).toBeNull();
  });

  it("a primeira edição de uma config legada regrava na forma nova", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ percent_a: 30 }} onChange={onChange} />);
    peso("A", "40");
    peso("B", "60");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ ramos: [{ peso: 40 }, { peso: 60 }] });
  });

  it("soma diferente de 100 mostra o erro e não chama onChange", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ ramos: [{ peso: 50 }, { peso: 50 }] }} onChange={onChange} />);
    peso("A", "60");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sorteio-erro").textContent).toBe("Os pesos das saídas precisam somar 100%.");
    expect(screen.getByTestId("sorteio-resumo").textContent).toBe("Soma dos pesos: 110%");
  });

  it.each(["", "12.5", "-3", "101"])("peso %j não grava e pede um inteiro de 0 a 100", (valor) => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ ramos: [{ peso: 50 }, { peso: 50 }] }} onChange={onChange} />);
    peso("A", valor);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sorteio-erro").textContent).toBe("Cada peso é um número inteiro de 0 a 100.");
  });

  it("peso 0 vale (saída reservada) desde que a soma feche", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ ramos: [{ peso: 50 }, { peso: 50 }] }} onChange={onChange} />);
    peso("A", "100");
    peso("B", "0");
    expect(onChange).toHaveBeenLastCalledWith({ ramos: [{ peso: 100 }, { peso: 0 }] });
    expect(screen.queryByTestId("sorteio-erro")).toBeNull();
  });

  it("adicionar saída cria a próxima letra com peso 0 e grava (a soma continua 100)", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ ramos: [{ peso: 50 }, { peso: 50 }] }} onChange={onChange} />);
    expect(screen.queryByTestId("sorteio-saida-C")).toBeNull();
    fireEvent.click(screen.getByTestId("sorteio-adicionar"));
    expect(screen.getByTestId("sorteio-saida-C")).toBeTruthy();
    expect(valorDe("sorteio-peso-C")).toBe("0");
    expect(onChange).toHaveBeenLastCalledWith({ ramos: [{ peso: 50 }, { peso: 50 }, { peso: 0 }] });
  });

  it("remover saída tira a linha e só grava se a soma continuar 100", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ ramos: [{ peso: 50 }, { peso: 50 }, { peso: 0 }] }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("sorteio-remover-C"));
    expect(screen.queryByTestId("sorteio-saida-C")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ ramos: [{ peso: 50 }, { peso: 50 }] });

    // Com duas saídas sobra o mínimo: o botão de remover some.
    expect(screen.queryByTestId("sorteio-remover-A")).toBeNull();
    expect(screen.queryByTestId("sorteio-remover-B")).toBeNull();
  });

  it("remover uma saída com peso quebra a soma: erro, sem gravar", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ ramos: [{ peso: 40 }, { peso: 30 }, { peso: 30 }] }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("sorteio-remover-C"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sorteio-erro").textContent).toBe("Os pesos das saídas precisam somar 100%.");
  });

  it("o limite é de 10 saídas: o botão de adicionar some na décima", () => {
    const dez = Array.from({ length: 9 }, () => ({ peso: 0 }));
    render(<SorteioForm config={{ ramos: [{ peso: 100 }, ...dez] }} onChange={vi.fn()} />);
    expect(screen.getByTestId("sorteio-saida-J")).toBeTruthy();
    expect(screen.queryByTestId("sorteio-adicionar")).toBeNull();
  });

  it("o nome é opcional e vai no ramo; apagar o nome o tira do ramo", () => {
    const onChange = vi.fn();
    render(<SorteioForm config={{ ramos: [{ peso: 50 }, { peso: 50 }] }} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("sorteio-nome-A"), { target: { value: "Kyla" } });
    expect(onChange).toHaveBeenLastCalledWith({ ramos: [{ peso: 50, nome: "Kyla" }, { peso: 50 }] });
    fireEvent.change(screen.getByTestId("sorteio-nome-A"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ramos: [{ peso: 50 }, { peso: 50 }] });
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

  it("o card do sorteio ponderado tem uma saída por ramo, com a letra, o nome e o peso", () => {
    const config = { ramos: [{ peso: 70, nome: "Kyla" }, { peso: 30 }, { peso: 0, nome: "Reserva" }] };
    expect(describeNodeConfig("random_split", config, (x) => x)).toBe("A 70% · B 30% · C 0%");
    render(
      <NodeCard
        id="s2"
        visual={NODE_VISUALS.random_split}
        label="Sorteio"
        subtitle={describeNodeConfig("random_split", config, (x) => x)}
        branches={nodeBranches({ type: "random_split", config })}
      />,
    );
    expect(screen.getByTestId("node-branch-s2-a").textContent).toContain("A · Kyla (70%)");
    expect(screen.getByTestId("node-branch-s2-b").textContent).toContain("B (30%)");
    expect(screen.getByTestId("node-branch-s2-c").textContent).toContain("C · Reserva (0%)");
  });

  it("a caixa está no menu de blocos da automação, em Lógica, e não no do follow-up", () => {
    const { unmount } = render(<NodePalette onAdd={() => {}} surface="automacao" />);
    expect(screen.getByTestId("palette-grupo-logica").querySelector('[data-testid="palette-add-random_split"]')).not.toBeNull();
    unmount();
    render(<NodePalette onAdd={() => {}} surface="followup" />);
    expect(screen.queryByTestId("palette-add-random_split")).toBeNull();
  });
});
