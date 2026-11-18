/**
 * A barra de salvar de Configurações e o aviso de saída sem salvar.
 *
 * Medido pelo que a pessoa vê e faz: a barra só aparece quando há mudança,
 * Descartar volta ao último salvo, Salvar grava e a barra some, a falha deixa
 * as mudanças na tela com "Tentar de novo"; e sair com mudança pendente
 * pergunta antes — pelo navegador (`beforeunload`) ou pela confirmação do
 * produto (clique num link interno).
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GrupoDeSalvar,
  useBarraDeSalvar,
  type DesfechoDoSalvar,
} from "@/components/configuracoes/grupo-de-salvar";
import {
  REARME_MS,
  useAvisoDeSaidaSemSalvar,
} from "@/components/configuracoes/use-aviso-de-saida-sem-salvar";
import { render } from "@/tests/helpers/render-com-confirmacao";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

/** Um formulário mínimo, do jeito que as telas usam a barra. */
function Formulario({
  gravar,
  rotulo = "Nome",
  inicial = "Ana",
}: {
  gravar: (v: string) => Promise<DesfechoDoSalvar>;
  rotulo?: string;
  inicial?: string;
}) {
  const [valor, setValor] = useState(inicial);
  const [salvo, setSalvo] = useState(inicial);
  const { barra, enviar } = useBarraDeSalvar({
    sujo: valor !== salvo,
    salvar: async () => {
      const r = await gravar(valor);
      if (r === "salvo") setSalvo(valor);
      return r;
    },
    descartar: () => setValor(salvo),
  });
  return (
    <form onSubmit={enviar}>
      <label>
        {rotulo}
        <input value={valor} onChange={(e) => setValor(e.target.value)} />
      </label>
      {barra}
    </form>
  );
}

const barra = () => screen.queryByRole("region", { name: "Alterações não salvas" });

beforeEach(() => push.mockReset());

describe("BarraDeSalvar", () => {
  it("não aparece sem mudança e aparece ao mudar", () => {
    render(<Formulario gravar={vi.fn()} />);
    expect(barra()).toBeNull();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Bia" } });
    expect(barra()).not.toBeNull();
    // Voltar ao valor salvo à mão também tira a barra: ela mede a diferença, não o toque.
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Ana" } });
    expect(barra()).toBeNull();
  });

  it("Descartar volta ao último salvo e a barra some", () => {
    const gravar = vi.fn();
    render(<Formulario gravar={gravar} />);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Bia" } });
    fireEvent.click(within(barra()!).getByRole("button", { name: "Descartar" }));
    expect(screen.getByLabelText("Nome")).toHaveValue("Ana");
    expect(barra()).toBeNull();
    expect(gravar).not.toHaveBeenCalled();
  });

  it("Salvar grava o valor da tela, mostra Salvando… e some ao terminar", async () => {
    let terminar: (d: DesfechoDoSalvar) => void = () => {};
    const gravar = vi.fn(() => new Promise<DesfechoDoSalvar>((r) => (terminar = r)));
    render(<Formulario gravar={gravar} />);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Bia" } });
    fireEvent.click(within(barra()!).getByRole("button", { name: "Salvar" }));
    expect(gravar).toHaveBeenCalledWith("Bia");
    expect(await within(barra()!).findByRole("button", { name: "Salvando…" })).toBeDisabled();
    expect(within(barra()!).getByRole("button", { name: "Descartar" })).toBeDisabled();
    await act(async () => terminar("salvo"));
    expect(barra()).toBeNull();
    expect(screen.getByLabelText("Nome")).toHaveValue("Bia");
  });

  it("Enter no campo salva pelo mesmo caminho do botão", async () => {
    const gravar = vi.fn(async () => "salvo" as const);
    render(<Formulario gravar={gravar} />);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Bia" } });
    fireEvent.submit(screen.getByLabelText("Nome").closest("form")!);
    await waitFor(() => expect(barra()).toBeNull());
    expect(gravar).toHaveBeenCalledTimes(1);
  });

  it("Enter num formulário sem mudança não grava", () => {
    const gravar = vi.fn(async () => "salvo" as const);
    render(<Formulario gravar={gravar} />);
    fireEvent.submit(screen.getByLabelText("Nome").closest("form")!);
    expect(gravar).not.toHaveBeenCalled();
    expect(barra()).toBeNull();
  });

  it("falha mostra o erro com Tentar de novo, mantém a mudança, e a nova tentativa grava", async () => {
    const gravar = vi
      .fn<(v: string) => Promise<DesfechoDoSalvar>>()
      .mockResolvedValueOnce("falhou");
    gravar.mockResolvedValueOnce("salvo");
    render(<Formulario gravar={gravar} />);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Bia" } });
    fireEvent.click(within(barra()!).getByRole("button", { name: "Salvar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não consegui salvar.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Suas mudanças continuam aqui. Tente de novo.",
    );
    expect(screen.getByLabelText("Nome")).toHaveValue("Bia");
    fireEvent.click(within(barra()!).getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(barra()).toBeNull());
    expect(gravar).toHaveBeenCalledTimes(2);
  });

  it("recusa de validação não vira erro de gravação", async () => {
    const gravar = vi.fn(async () => "invalido" as const);
    render(<Formulario gravar={gravar} />);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Bia" } });
    fireEvent.click(within(barra()!).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(gravar).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(barra()!).getByRole("button", { name: "Salvar" })).toBeEnabled();
  });
});

describe("GrupoDeSalvar: vários formulários, uma barra", () => {
  it("mostra UMA barra, salva só o que mudou e descarta todos", async () => {
    const gravarA = vi.fn(async () => "salvo" as const);
    const gravarB = vi.fn(async () => "salvo" as const);
    render(
      <GrupoDeSalvar>
        <Formulario rotulo="Primeiro" gravar={gravarA} />
        <Formulario rotulo="Segundo" gravar={gravarB} />
      </GrupoDeSalvar>,
    );
    expect(barra()).toBeNull();
    fireEvent.change(screen.getByLabelText("Primeiro"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Segundo"), { target: { value: "Y" } });
    expect(screen.getAllByRole("region", { name: "Alterações não salvas" })).toHaveLength(1);

    fireEvent.click(within(barra()!).getByRole("button", { name: "Descartar" }));
    expect(screen.getByLabelText("Primeiro")).toHaveValue("Ana");
    expect(screen.getByLabelText("Segundo")).toHaveValue("Ana");
    expect(barra()).toBeNull();

    fireEvent.change(screen.getByLabelText("Segundo"), { target: { value: "Z" } });
    fireEvent.click(within(barra()!).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(barra()).toBeNull());
    expect(gravarA).not.toHaveBeenCalled();
    expect(gravarB).toHaveBeenCalledWith("Z");
  });

  it("falha numa parte deixa a barra em erro e só ela suja", async () => {
    const gravarA = vi.fn(async () => "salvo" as const);
    const gravarB = vi.fn(async () => "falhou" as const);
    render(
      <GrupoDeSalvar>
        <Formulario rotulo="Primeiro" gravar={gravarA} />
        <Formulario rotulo="Segundo" gravar={gravarB} />
      </GrupoDeSalvar>,
    );
    fireEvent.change(screen.getByLabelText("Primeiro"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Segundo"), { target: { value: "Y" } });
    fireEvent.click(within(barra()!).getByRole("button", { name: "Salvar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não consegui salvar.");
    fireEvent.click(within(barra()!).getByRole("button", { name: "Descartar" }));
    // O que gravou fica gravado; só o que falhou volta.
    expect(screen.getByLabelText("Primeiro")).toHaveValue("X");
    expect(screen.getByLabelText("Segundo")).toHaveValue("Ana");
    expect(barra()).toBeNull();
  });
});

/** Faz as vezes do `next/link`: o clique que chega até ele vira navegação do app. */
const navegouPeloLink = vi.fn();

/** Uma parte que sai da tela por conta própria (como o desafio do segundo fator). */
function ParteQueSai() {
  const [valor, setValor] = useState("Ana");
  const { enviar, liberarSaida } = useBarraDeSalvar({
    sujo: valor !== "Ana",
    salvar: async () => "salvo",
    descartar: () => setValor("Ana"),
  });
  return (
    <form onSubmit={enviar}>
      <label>
        Campo
        <input value={valor} onChange={(e) => setValor(e.target.value)} />
      </label>
      <button type="button" onClick={liberarSaida}>
        Sair pela tela
      </button>
    </form>
  );
}

describe("GrupoDeSalvar: liberarSaida de uma parte", () => {
  it("libera o aviso do grupo, que é quem pergunta", () => {
    render(
      <GrupoDeSalvar>
        <ParteQueSai />
      </GrupoDeSalvar>,
    );
    fireEvent.change(screen.getByLabelText("Campo"), { target: { value: "Bia" } });
    const antes = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(antes);
    expect(antes.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Sair pela tela" }));
    const depois = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(depois);
    expect(depois.defaultPrevented).toBe(false);
  });
});

function Guardado({ sujo, comLink = true }: { sujo: boolean; comLink?: boolean }) {
  const { liberarSaida } = useAvisoDeSaidaSemSalvar(sujo);
  return (
    <div>
      {comLink ? (
        <a
          href="/app/settings/tenant"
          onClick={(e) => {
            e.preventDefault();
            navegouPeloLink();
          }}
        >
          Organização
        </a>
      ) : null}
      <a href="#secao">Âncora</a>
      <a href="/app/settings/tenant" target="_blank">
        Nova aba
      </a>
      <a href="/api/v1/lgpd/export/arquivo.pdf">Baixar pela API</a>
      <a href="/app/settings/arquivo.csv" download>
        Baixar arquivo
      </a>
      <button type="button" onClick={liberarSaida}>
        Liberar
      </button>
    </div>
  );
}

describe("useAvisoDeSaidaSemSalvar", () => {
  let tipos: string[] = [];
  let adicionar: { mockRestore: () => void };
  beforeEach(() => {
    tipos = [];
    const original = window.addEventListener.bind(window);
    adicionar = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((tipo: string, ...resto: unknown[]) => {
        tipos.push(tipo);
        return (original as (...a: unknown[]) => void)(tipo, ...resto);
      });
  });
  afterEach(() => adicionar.mockRestore());

  const registrouBeforeunload = () => tipos.includes("beforeunload");

  it("só registra o beforeunload quando há mudança, e ele pede para o navegador perguntar", () => {
    const { rerender } = render(<Guardado sujo={false} />);
    expect(registrouBeforeunload()).toBe(false);

    rerender(<Guardado sujo />);
    expect(registrouBeforeunload()).toBe(true);
    const evento = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(evento);
    expect(evento.defaultPrevented).toBe(true);

    rerender(<Guardado sujo={false} />);
    const depois = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(depois);
    expect(depois.defaultPrevented).toBe(false);
  });

  it("clique em link interno com mudança pergunta; Continuar editando não navega", async () => {
    render(<Guardado sujo />);
    const clique = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    screen.getByRole("link", { name: "Organização" }).dispatchEvent(clique);
    expect(clique.defaultPrevented).toBe(true);

    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo).toHaveTextContent("Sair sem salvar?");
    expect(dialogo).toHaveTextContent("As mudanças desta tela vão se perder.");
    fireEvent.click(within(dialogo).getByRole("button", { name: "Continuar editando" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(push).not.toHaveBeenCalled();
  });

  it("Descartar e sair entrega o clique ao próprio link (que sabe o replace e o scroll dele)", async () => {
    navegouPeloLink.mockReset();
    render(<Guardado sujo />);
    fireEvent.click(screen.getByRole("link", { name: "Organização" }));
    expect(navegouPeloLink).not.toHaveBeenCalled();
    const dialogo = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialogo).getByRole("button", { name: "Descartar e sair" }));
    await waitFor(() => expect(navegouPeloLink).toHaveBeenCalledTimes(1));
    expect(push).not.toHaveBeenCalled();
  });

  it("se o link saiu da tela durante a pergunta, Descartar e sair navega pelo roteador", async () => {
    const { rerender } = render(<Guardado sujo />);
    fireEvent.click(screen.getByRole("link", { name: "Organização" }));
    const dialogo = await screen.findByRole("alertdialog");
    rerender(<Guardado sujo comLink={false} />);
    fireEvent.click(within(dialogo).getByRole("button", { name: "Descartar e sair" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/settings/tenant"));
  });

  it("não intercepta link para /api/, link com download, Shift, Alt nem botão do meio", () => {
    render(<Guardado sujo />);
    const semNavegar = (e: Event) => e.preventDefault();
    document.addEventListener("click", semNavegar);
    try {
      const segurou = (nome: string, extra: MouseEventInit = {}) => {
        const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...extra });
        const parou = vi.spyOn(e, "stopPropagation");
        screen.getByRole("link", { name: nome }).dispatchEvent(e);
        return parou.mock.calls.length > 0 || screen.queryByRole("alertdialog") !== null;
      };
      expect(segurou("Baixar pela API")).toBe(false);
      expect(segurou("Baixar arquivo")).toBe(false);
      expect(segurou("Nova aba")).toBe(false);
      expect(segurou("Organização", { shiftKey: true })).toBe(false);
      expect(segurou("Organização", { altKey: true })).toBe(false);
      expect(segurou("Organização", { button: 1 })).toBe(false);
    } finally {
      document.removeEventListener("click", semNavegar);
    }
    expect(push).not.toHaveBeenCalled();
  });

  it("liberarSaida vale por um instante: se a página continua aqui, o aviso volta", () => {
    vi.useFakeTimers();
    try {
      render(<Guardado sujo />);
      fireEvent.click(screen.getByRole("button", { name: "Liberar" }));
      const liberada = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(liberada);
      expect(liberada.defaultPrevented).toBe(false);

      act(() => {
        vi.advanceTimersByTime(REARME_MS);
      });
      const depois = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(depois);
      expect(depois.defaultPrevented).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("não intercepta sem mudança, nem âncora da mesma tela, nova aba ou clique com Ctrl", () => {
    const { rerender } = render(<Guardado sujo={false} />);
    const clicar = (nome: string, extra: MouseEventInit = {}) => {
      const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...extra });
      screen.getByRole("link", { name: nome }).dispatchEvent(e);
      return e.defaultPrevented;
    };
    // jsdom não navega; o que importa é a tela não segurar o clique.
    const semNavegar = (e: Event) => e.preventDefault();
    navegouPeloLink.mockReset();
    clicar("Organização");
    // Sem mudança o clique chega ao link (o "next/link" daqui) sem pergunta.
    expect(navegouPeloLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    rerender(<Guardado sujo />);
    document.addEventListener("click", semNavegar);
    try {
      const naoSegurou = (nome: string, extra?: MouseEventInit) => {
        clicar(nome, extra);
        return screen.queryByRole("alertdialog") === null;
      };
      expect(naoSegurou("Âncora")).toBe(true);
      expect(naoSegurou("Nova aba")).toBe(true);
      expect(naoSegurou("Organização", { ctrlKey: true })).toBe(true);
      expect(naoSegurou("Organização", { metaKey: true })).toBe(true);
    } finally {
      document.removeEventListener("click", semNavegar);
    }
    expect(push).not.toHaveBeenCalled();
  });
});

describe("useAvisoDeSaidaSemSalvar: Voltar/Avançar do navegador", () => {
  const enderecoOriginal = window.location.pathname + window.location.search;
  let go: ReturnType<typeof vi.spyOn>;
  /** Faz as vezes do roteador do Next, que ouve `popstate` sem captura. */
  const roteador = vi.fn();

  beforeEach(() => {
    go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    roteador.mockReset();
    window.addEventListener("popstate", roteador);
  });
  afterEach(() => {
    go.mockRestore();
    window.removeEventListener("popstate", roteador);
    window.history.replaceState(null, "", enderecoOriginal);
  });

  /** O navegador já trocou a URL quando o `popstate` chega. */
  function voltarPara(endereco: string) {
    window.history.replaceState(null, "", endereco);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  }

  it("com mudança, Voltar pergunta, desfaz a travessia e o roteador não troca a tela", async () => {
    render(<Guardado sujo />);
    voltarPara("/app/pagina-anterior");
    expect(roteador).not.toHaveBeenCalled();
    // Sem a Navigation API (jsdom), a travessia é tratada como Voltar: desfaz com +1.
    expect(go).toHaveBeenCalledWith(1);

    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo).toHaveTextContent("Sair sem salvar?");
    fireEvent.click(within(dialogo).getByRole("button", { name: "Continuar editando" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("Descartar e sair refaz a travessia, e o roteador recebe essa", async () => {
    render(<Guardado sujo />);
    voltarPara("/app/pagina-anterior");
    const dialogo = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialogo).getByRole("button", { name: "Descartar e sair" }));
    await waitFor(() => expect(go).toHaveBeenLastCalledWith(-1));

    // A travessia refeita chega como um `popstate` comum: passa ao roteador.
    voltarPara("/app/pagina-anterior");
    expect(roteador).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("sem mudança, ou só trocando a âncora da mesma tela, não pergunta", () => {
    const { rerender } = render(<Guardado sujo={false} />);
    voltarPara("/app/pagina-anterior");
    expect(roteador).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();

    window.history.replaceState(null, "", enderecoOriginal);
    rerender(<Guardado sujo />);
    voltarPara(`${enderecoOriginal}#secao`);
    expect(roteador).toHaveBeenCalledTimes(2);
    expect(go).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
