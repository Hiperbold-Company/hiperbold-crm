/**
 * A tela dos campos da organização (1015): dois acordeões, o diálogo de quatro abas e a contagem
 * antes de excluir. A rede é o `fetch` (a rota), trocado por um receptor que guarda o que chegou.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { alteracaoDeDefinicaoSchema, novaDefinicaoSchema, type DefinicaoDeCampo } from "@/lib/campos/definicoes";

import { CamposPersonalizadosClient, chaveDoNome, corpoDoRascunho, rascunhoDe } from "./_client";

const CAMPO: DefinicaoDeCampo = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "org",
  entidade: "negocio",
  key: "origem",
  label: "Origem",
  type: "select",
  descricao: null,
  grupo: null,
  obrigatorio: false,
  publico: false,
  sempre_visivel: true,
  exibir_no_perfil: false,
  dica_de_ajuda: null,
  config: { options: [{ value: "site", label: "Site" }] },
  position: 1000,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  created_by: null,
  updated_by: null,
};

const chamadas: Array<{ url: string; init?: RequestInit }> = [];
beforeEach(() => {
  chamadas.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      chamadas.push({ url, init });
      if (url.endsWith("/stats")) {
        return new Response(
          JSON.stringify({
            data: { total: 10, preenchidos: 4, vazios: 6, taxa: 40, ultimo_uso: null, tamanho_medio: 4, criado_em: CAMPO.created_at, editado_em: CAMPO.updated_at },
          }),
        );
      }
      const corpo = init?.body ? JSON.parse(String(init.body)) : {};
      return new Response(JSON.stringify({ data: { ...CAMPO, ...corpo, id: "novo", entidade: corpo.entidade ?? "negocio" } }), { status: 201 });
    }),
  );
});

describe("Configurações › Campos Personalizados", () => {
  it("dois acordeões, Contatos e Negócios, cada campo no seu, com os selos", () => {
    render(<CamposPersonalizadosClient iniciais={[CAMPO]} />);
    const negocios = screen.getByTestId("acordeao-negocio");
    expect(negocios).toHaveTextContent("Origem");
    expect(negocios).toHaveTextContent("Só administradores");
    expect(negocios).toHaveTextContent("Sempre visível");
    expect(screen.getByTestId("acordeao-contato")).toHaveTextContent("Nenhum campo cadastrado.");
  });

  it("Novo campo de Contatos cria com entidade contato e a chave sugerida pelo nome", async () => {
    render(<CamposPersonalizadosClient iniciais={[]} />);
    fireEvent.click(screen.getByTestId("novo-campo-contato"));
    fireEvent.change(screen.getByLabelText("Nome *"), { target: { value: "Data de nascimento" } });
    fireEvent.click(screen.getByTestId("salvar-campo"));
    await waitFor(() => expect(chamadas.length).toBe(1));
    expect(chamadas[0]?.url).toBe("/api/v1/custom-fields");
    expect(JSON.parse(String(chamadas[0]?.init?.body))).toMatchObject({
      entidade: "contato",
      key: "data_de_nascimento",
      label: "Data de nascimento",
      type: "text",
    });
  });

  it("as quatro abas aparecem na edição, o tipo fica travado e Estatísticas mostra a taxa", async () => {
    render(<CamposPersonalizadosClient iniciais={[CAMPO]} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    for (const aba of ["Campo", "Tipo de dado", "Avançado", "Estatísticas"]) {
      expect(screen.getByRole("tab", { name: aba })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("tab", { name: "Tipo de dado" }));
    expect(screen.getByTestId("tipo-text")).toBeDisabled();
    expect(screen.getByTestId("tipo-select")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Estatísticas" }));
    expect(await screen.findByText(/Taxa de preenchimento: 40%/)).toBeInTheDocument();
    expect(screen.getByText(/Registros vazios: 6/)).toBeInTheDocument();
  });

  it("excluir pergunta antes, com a contagem de registros que têm valor", async () => {
    render(<CamposPersonalizadosClient iniciais={[CAMPO]} />);
    fireEvent.click(screen.getByRole("button", { name: "Excluir Origem" }));
    expect(await screen.findByText(/^4 registros têm valor/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("confirmar-exclusao"));
    await waitFor(() => expect(chamadas.at(-1)?.init?.method).toBe("DELETE"));
  });
});

describe("moeda por campo", () => {
  const MOEDA: DefinicaoDeCampo = { ...CAMPO, key: "investimento", label: "Valor de investimento", type: "currency", config: {} };

  it("o botão do tipo diz só Moeda e escolher o tipo mostra o seletor, na moeda da organização", async () => {
    render(<CamposPersonalizadosClient iniciais={[]} />);
    fireEvent.click(screen.getByTestId("novo-campo-negocio"));
    await userEvent.click(screen.getByRole("tab", { name: "Tipo de dado" }));
    expect(screen.queryByTestId("moeda-do-campo")).toBeNull();
    const botao = screen.getByTestId("tipo-currency");
    expect(botao).toHaveTextContent(/^Moeda$/);
    await userEvent.click(botao);
    const seletor = screen.getByLabelText("Moeda do campo") as HTMLSelectElement;
    expect([...seletor.options].map((o) => o.value)).toEqual(["BRL", "USD", "EUR"]);
    expect(seletor.value).toBe("BRL");
  });

  it("criar um campo em dólar grava config.moeda", async () => {
    render(<CamposPersonalizadosClient iniciais={[]} />);
    fireEvent.click(screen.getByTestId("novo-campo-negocio"));
    fireEvent.change(screen.getByLabelText("Nome *"), { target: { value: "Valor de investimento" } });
    await userEvent.click(screen.getByRole("tab", { name: "Tipo de dado" }));
    await userEvent.click(screen.getByTestId("tipo-currency"));
    await userEvent.selectOptions(screen.getByLabelText("Moeda do campo"), "USD");
    fireEvent.click(screen.getByTestId("salvar-campo"));
    await waitFor(() => expect(chamadas.length).toBe(1));
    expect(JSON.parse(String(chamadas[0]?.init?.body))).toMatchObject({ type: "currency", config: { moeda: "USD" } });
  });

  it("campo antigo sem moeda abre com a da organização marcada, e a lista diz Moeda (BRL)", async () => {
    render(<CamposPersonalizadosClient iniciais={[MOEDA, { ...MOEDA, id: "22222222-2222-4222-8222-222222222222", key: "usd", label: "Em dólar", config: { moeda: "USD" } }]} />);
    expect(screen.getByTestId("campo-investimento")).toHaveTextContent("Moeda (BRL)");
    expect(screen.getByTestId("campo-usd")).toHaveTextContent("Moeda (USD)");
    fireEvent.click(screen.getAllByRole("button", { name: "Editar" })[0]!);
    await userEvent.click(screen.getByRole("tab", { name: "Tipo de dado" }));
    expect((screen.getByLabelText("Moeda do campo") as HTMLSelectElement).value).toBe("BRL");
    expect(screen.getByText("Trocar a moeda não converte os valores já gravados.")).toBeInTheDocument();
  });

  it("sem escolha, nada de moeda no config; com escolha, vai na edição", () => {
    expect(corpoDoRascunho(rascunhoDe(MOEDA)).config).not.toHaveProperty("moeda");
    expect(corpoDoRascunho({ ...rascunhoDe(MOEDA), moeda: "EUR" }).config).toMatchObject({ moeda: "EUR" });
    expect(rascunhoDe({ ...MOEDA, config: { moeda: "USD" } }).moeda).toBe("USD");
    expect(rascunhoDe({ ...MOEDA, config: { moeda: "GBP" } }).moeda).toBe("");
  });
});

describe("o corpo que a tela manda", () => {
  it("edição NUNCA leva key, type nem entidade (a rota recusaria)", () => {
    const corpo = corpoDoRascunho(rascunhoDe(CAMPO));
    expect(corpo).not.toHaveProperty("key");
    expect(corpo).not.toHaveProperty("type");
    expect(corpo).not.toHaveProperty("entidade");
    expect(corpo.config).toMatchObject({ options: [{ value: "site", label: "Site" }], padrao: null });
  });

  it("o corpo que a tela manda na edição e na criação PASSA no schema da rota (sem 422)", () => {
    const edicao = corpoDoRascunho(rascunhoDe(CAMPO));
    expect(alteracaoDeDefinicaoSchema.safeParse(edicao).success).toBe(true);
    const comMoeda = corpoDoRascunho({ ...rascunhoDe({ ...CAMPO, type: "currency", config: {} }), moeda: "USD" });
    expect(alteracaoDeDefinicaoSchema.safeParse(comMoeda).success).toBe(true);
    const criacao = corpoDoRascunho({ ...rascunhoDe(CAMPO), id: null, entidade: "negocio" });
    expect(novaDefinicaoSchema.safeParse(criacao).success).toBe(true);
  });

  it("a chave sugerida tira acento e começa por letra", () => {
    expect(chaveDoNome("Órgão emissor")).toBe("orgao_emissor");
    expect(chaveDoNome("2ª via")).toMatch(/^campo_/);
  });
});
