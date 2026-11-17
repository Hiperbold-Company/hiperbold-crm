// @vitest-environment jsdom
/**
 * Os componentes de base do item 9: confirmação única (no lugar de
 * window.confirm/prompt), caixa de marcar, barra de progresso e paginação.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { ProvedorDeConfirmacao, useConfirmar } from "@/components/ui/confirmar";
import { Paginacao } from "@/components/ui/paginacao";
import { Progress } from "@/components/ui/progress";

afterEach(cleanup);

function Gatilho({ acao }: { acao: (api: ReturnType<typeof useConfirmar>) => Promise<unknown> }) {
  const api = useConfirmar();
  const [res, setRes] = useState("nada");
  return (
    <>
      <button type="button" onClick={() => void acao(api).then((r) => setRes(JSON.stringify(r)))}>
        abrir
      </button>
      <output>{res}</output>
    </>
  );
}

function montar(acao: Parameters<typeof Gatilho>[0]["acao"]) {
  render(
    <ProvedorDeConfirmacao>
      <Gatilho acao={acao} />
    </ProvedorDeConfirmacao>,
  );
  fireEvent.click(screen.getByText("abrir"));
}

describe("useConfirmar", () => {
  it("sem provedor, falha dizendo onde montar", () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Gatilho acao={async () => null} />)).toThrow(/ProvedorDeConfirmacao/);
    erro.mockRestore();
  });

  it("confirmar: título, descrição e rótulo próprio; Confirmar resolve true", async () => {
    montar((api) => api.confirmar({ titulo: "Remover este modelo?", descricao: "Não volta.", confirmar: "Remover" }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo.textContent).toContain("Remover este modelo?");
    expect(dialogo.textContent).toContain("Não volta.");
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("true"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("confirmar: Cancelar resolve false", async () => {
    montar((api) => api.confirmar({ titulo: "Sair?" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("false"));
  });

  it("confirmar: Esc conta como cancelar", async () => {
    montar((api) => api.confirmar({ titulo: "Sair?" }));
    const dialogo = await screen.findByRole("alertdialog");
    fireEvent.keyDown(dialogo, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("false"));
  });

  it("perigo: o botão de confirmar sai na cor de erro", async () => {
    montar((api) => api.confirmar({ titulo: "Apagar?", confirmar: "Apagar", perigo: true }));
    await screen.findByRole("alertdialog");
    expect(screen.getByRole("button", { name: "Apagar" }).className).toContain("bg-error");
  });

  it("perguntar: devolve o texto aparado", async () => {
    montar((api) => api.perguntar({ titulo: "Motivo", rotulo: "Motivo da recusa" }));
    await screen.findByRole("alertdialog");
    const confirmar = screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true); // obrigatório: vazio não confirma
    fireEvent.change(screen.getByLabelText("Motivo da recusa"), { target: { value: "  caro demais  " } });
    expect(confirmar.disabled).toBe(false);
    fireEvent.click(confirmar);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe('"caro demais"'));
  });

  it("perguntar opcional: confirma vazio com string vazia; cancelar devolve null", async () => {
    montar((api) => api.perguntar({ titulo: "Motivo", opcional: true }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe('""'));

    fireEvent.click(screen.getByText("abrir"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("null"));
  });

  it("pedido novo cancela o anterior em vez de deixá-lo pendurado", async () => {
    let primeiro: Promise<boolean> | null = null;
    const caixa: { api: ReturnType<typeof useConfirmar> | null } = { api: null };
    function Captura() {
      const api = useConfirmar();
      useEffect(() => {
        caixa.api = api;
      }, [api]);
      return null;
    }
    render(
      <ProvedorDeConfirmacao>
        <Captura />
      </ProvedorDeConfirmacao>,
    );
    act(() => {
      primeiro = caixa.api!.confirmar({ titulo: "Primeiro" });
    });
    act(() => {
      void caixa.api!.confirmar({ titulo: "Segundo" });
    });
    await expect(primeiro).resolves.toBe(false);
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Segundo");
  });
});

describe("ProvedorDeConfirmacao — pergunta deslocada", () => {
  it("um perguntar deslocado por um confirmar devolve null, nunca false", async () => {
    let primeiro: Promise<string | null> | null = null;
    const caixa: { api: ReturnType<typeof useConfirmar> | null } = { api: null };
    function Captura() {
      const api = useConfirmar();
      useEffect(() => {
        caixa.api = api;
      }, [api]);
      return null;
    }
    render(
      <ProvedorDeConfirmacao>
        <Captura />
      </ProvedorDeConfirmacao>,
    );
    act(() => {
      primeiro = caixa.api!.perguntar({ titulo: "Motivo", opcional: true });
    });
    act(() => {
      void caixa.api!.confirmar({ titulo: "Outro" });
    });
    await expect(primeiro).resolves.toBeNull();
  });
});

describe("Checkbox", () => {
  it("é a caixa nativa: marca, desmarca e respeita disabled", () => {
    const onChange = vi.fn();
    render(<Checkbox aria-label="Aceito" onChange={onChange} />);
    const caixa = screen.getByRole("checkbox", { name: "Aceito" }) as HTMLInputElement;
    fireEvent.click(caixa);
    expect(caixa.checked).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Checkbox aria-label="Travada" disabled />);
    expect((screen.getByRole("checkbox", { name: "Travada" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("indeterminado liga a propriedade e o aria-checked=mixed, e desliga ao sair", () => {
    const { rerender } = render(<Checkbox aria-label="Todos" indeterminado />);
    const caixa = screen.getByRole("checkbox", { name: "Todos" }) as HTMLInputElement;
    expect(caixa.indeterminate).toBe(true);
    expect(caixa.getAttribute("aria-checked")).toBe("mixed");
    rerender(<Checkbox aria-label="Todos" />);
    expect(caixa.indeterminate).toBe(false);
    expect(caixa.hasAttribute("aria-checked")).toBe(false);
  });

  it("repassa o ref para o input", () => {
    let el: HTMLInputElement | null = null;
    render(<Checkbox aria-label="Ref" ref={(r) => { el = r; }} />);
    expect(el).toBeInstanceOf(HTMLInputElement);
  });
});

describe("Progress", () => {
  function barra() {
    return screen.getByRole("progressbar");
  }
  function largura() {
    return (barra().firstElementChild as HTMLElement).style.width;
  }

  it("anuncia nome e valores e preenche na proporção", () => {
    render(<Progress rotulo="Uso do plano" valor={30} maximo={120} />);
    expect(barra().getAttribute("aria-label")).toBe("Uso do plano");
    expect(barra().getAttribute("aria-valuemin")).toBe("0");
    expect(barra().getAttribute("aria-valuemax")).toBe("120");
    expect(barra().getAttribute("aria-valuenow")).toBe("30");
    expect(largura()).toBe("25%");
  });

  it("apara valor fora da trilha e trata NaN e máximo inválido", () => {
    const { rerender } = render(<Progress rotulo="x" valor={250} />);
    expect(largura()).toBe("100%");
    rerender(<Progress rotulo="x" valor={-5} />);
    expect(largura()).toBe("0%");
    rerender(<Progress rotulo="x" valor={Number.NaN} />);
    expect(largura()).toBe("0%");
    rerender(<Progress rotulo="x" valor={50} maximo={0} />);
    expect(barra().getAttribute("aria-valuemax")).toBe("100");
    expect(largura()).toBe("50%");
  });

  it("tom escolhe a cor de estado", () => {
    render(<Progress rotulo="x" valor={10} tom="erro" />);
    expect((barra().firstElementChild as HTMLElement).className).toContain("bg-error");
  });
});

describe("Paginacao", () => {
  it("com total: posição, Anterior desligado na primeira e onIr nas duas direções", () => {
    const onIr = vi.fn();
    const { rerender } = render(<Paginacao pagina={1} totalDePaginas={3} onIr={onIr} />);
    expect(screen.getByRole("navigation", { name: "Paginação" })).toBeTruthy();
    expect(screen.getByText("Página 1 de 3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Página anterior" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(onIr).toHaveBeenLastCalledWith(2);

    rerender(<Paginacao pagina={3} totalDePaginas={3} onIr={onIr} />);
    expect((screen.getByRole("button", { name: "Próxima página" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Página anterior" }));
    expect(onIr).toHaveBeenLastCalledWith(2);
  });

  it("sem total (cursor): mostra só a página e obedece temProxima", () => {
    const { rerender } = render(<Paginacao pagina={2} temProxima onIr={() => {}} />);
    expect(screen.getByText("Página 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Próxima página" }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<Paginacao pagina={2} onIr={() => {}} />);
    expect((screen.getByRole("button", { name: "Próxima página" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("carregando desliga as duas setas", () => {
    render(<Paginacao pagina={2} totalDePaginas={5} carregando onIr={() => {}} />);
    for (const nome of ["Página anterior", "Próxima página"]) {
      expect((screen.getByRole("button", { name: nome }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("hrefDaPagina vira link; a seta sem destino continua botão desligado", () => {
    render(<Paginacao pagina={1} totalDePaginas={4} hrefDaPagina={(p) => `/app/contacts?pagina=${p}`} />);
    expect(screen.getByRole("link", { name: "Próxima página" }).getAttribute("href")).toBe("/app/contacts?pagina=2");
    expect((screen.getByRole("button", { name: "Página anterior" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("total zero não mostra 'de 0'", () => {
    render(<Paginacao pagina={1} totalDePaginas={0} onIr={() => {}} />);
    expect(screen.getByText("Página 1 de 1")).toBeTruthy();
  });
});
