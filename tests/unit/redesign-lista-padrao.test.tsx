/**
 * PADRÃO DE LISTA DO V49 — onda 1 do redesign.
 *
 * Uma peça só para as telas de lista do protótipo: resumo de 3 números, busca,
 * pílulas de filtro com contagem, tabela e painel lateral com o detalhe da
 * linha. A tela fornece os dados e o critério de filtro; a peça cuida do
 * estado (busca, pílula, linha aberta) e da acessibilidade.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ListaPadrao } from "@/components/redesign/ListaPadrao";

interface Plano {
  id: string;
  nome: string;
  status: "ativo" | "pausado";
}

const linhas: Plano[] = [
  { id: "1", nome: "Boas-vindas", status: "ativo" },
  { id: "2", nome: "Pós-venda", status: "pausado" },
  { id: "3", nome: "Reativação", status: "ativo" },
];

function montar(extra: Partial<Parameters<typeof ListaPadrao<Plano>>[0]> = {}) {
  return render(
    <ListaPadrao<Plano>
      rotulo="Planos de tarefa"
      resumo={[
        { rotulo: "Planos", valor: "3" },
        { rotulo: "Ativos", valor: "2" },
        { rotulo: "Pausados", valor: "1" },
      ]}
      busca={{ placeholder: "Buscar por nome" }}
      pilulas={[
        { id: "todos", rotulo: "Todos", contagem: 3 },
        { id: "ativo", rotulo: "Ativos", contagem: 2 },
        { id: "pausado", rotulo: "Pausados", contagem: 1 },
      ]}
      colunas={[
        { id: "nome", titulo: "Nome", celula: (p) => p.nome },
        { id: "status", titulo: "Status", celula: (p) => p.status },
      ]}
      linhas={linhas}
      chave={(p) => p.id}
      filtrar={(p, { busca, pilula }) =>
        (pilula === "todos" || p.status === pilula) && p.nome.toLowerCase().includes(busca.toLowerCase())
      }
      painel={(p) => <p>Detalhe de {p.nome}</p>}
      tituloDoPainel={(p) => p.nome}
      vazio="Nenhum plano encontrado"
      {...extra}
    />,
  );
}

const nomesNaTabela = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]!.textContent);

afterEach(cleanup);

describe("ListaPadrao — resumo, busca, pílulas, tabela e painel", () => {
  it("mostra os 3 números do resumo com seus rótulos", () => {
    montar();
    const resumo = screen.getByRole("list", { name: /resumo/i });
    const itens = within(resumo).getAllByRole("listitem");
    expect(itens).toHaveLength(3);
    expect(itens[1]!.textContent).toContain("Ativos");
    expect(itens[1]!.textContent).toContain("2");
  });

  it("a tabela tem os títulos das colunas e uma linha por item", () => {
    montar();
    expect(screen.getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Nome", "Status"]);
    expect(nomesNaTabela()).toEqual(["Boas-vindas", "Pós-venda", "Reativação"]);
  });

  it("a busca filtra as linhas pelo critério da tela", () => {
    montar();
    fireEvent.change(screen.getByRole("searchbox", { name: /buscar por nome/i }), { target: { value: "pós" } });
    expect(nomesNaTabela()).toEqual(["Pós-venda"]);
  });

  it("a pílula mostra a contagem, fica marcada e filtra", () => {
    montar();
    const pausados = screen.getByRole("button", { name: /pausados/i });
    expect(pausados.textContent).toContain("1");
    expect(screen.getByRole("button", { name: /todos/i }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pausados);
    expect(pausados.getAttribute("aria-pressed")).toBe("true");
    expect(nomesNaTabela()).toEqual(["Pós-venda"]);
  });

  it("busca e pílula combinam", () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: /ativos/i }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "reat" } });
    expect(nomesNaTabela()).toEqual(["Reativação"]);
  });

  it("sem resultado, mostra o vazio e nenhuma linha de dado", () => {
    montar();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("Nenhum plano encontrado")).toBeTruthy();
    expect(screen.queryAllByRole("row").slice(1)).toHaveLength(0);
  });

  it("clicar na linha abre o painel lateral com o detalhe e o título dela", () => {
    montar();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("Pós-venda"));
    const painel = screen.getByRole("dialog", { name: "Pós-venda" });
    expect(within(painel).getByText("Detalhe de Pós-venda")).toBeTruthy();
  });

  it("a linha abre pelo teclado (Enter)", () => {
    montar();
    const linha = screen.getAllByRole("row")[1]!;
    linha.focus();
    fireEvent.keyDown(linha, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Boas-vindas" })).toBeTruthy();
  });

  it("o painel fecha pelo botão Fechar e pelo Esc", () => {
    montar();
    fireEvent.click(screen.getByText("Reativação"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /fechar/i }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByText("Reativação"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sem painel declarado, a linha não vira botão", () => {
    montar({ painel: undefined, tituloDoPainel: undefined });
    fireEvent.click(screen.getByText("Pós-venda"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ações do cabeçalho aparecem ao lado do título", () => {
    montar({ acoes: <button type="button">Novo plano</button> });
    expect(screen.getByRole("button", { name: "Novo plano" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Planos de tarefa" })).toBeTruthy();
  });
});
