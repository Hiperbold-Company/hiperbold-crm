/**
 * Tela "Cupons" do admin da plataforma (`/admin/sistema/cupons`, migration 0955): a lista (código, desconto,
 * planos e ciclos, validade, usos, ativo), ativar e desativar com confirmação, e o formulário de cupom novo.
 *
 * O limite é a ação de servidor (`criarCupom`, `definirCupomAtivo`), que tem o gate, a regra e a auditoria
 * provados em `asaas-cupons-admin.test.ts` e no banco. Aqui se mede o que a pessoa vê e o que a tela manda:
 * a conversão de "R$ 50,00" para centavos, da data para o fim do dia em Brasília, e de plano e ciclo
 * desmarcados para "todos".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const criarCupom = vi.fn();
const definirCupomAtivo = vi.fn();
vi.mock("@/app/actions/admin/cupons", () => ({
  criarCupom: (...args: unknown[]) => criarCupom(...args),
  definirCupomAtivo: (...args: unknown[]) => definirCupomAtivo(...args),
}));

import { FormularioDeNovoCupom, ListaDeCupons } from "@/app/admin/(protected)/sistema/cupons/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { CupomListado } from "@/app/actions/admin/cupons";

const PLANOS = [
  { code: "pro", name: "Pro" },
  { code: "max", name: "Max" },
];

const BASE: CupomListado = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "PCT10",
  tipo: "percentual",
  valor: 10,
  planos: [],
  ciclos: [],
  valido_ate: null,
  max_usos: null,
  ativo: true,
  descricao: null,
  criado_em: "2026-10-01T12:00:00Z",
  usos_pagos: 0,
  usos_abertos: 0,
};

function renderizar(ui: React.ReactElement) {
  return render(<IdiomaProvider locale="pt-BR">{ui}</IdiomaProvider>);
}

beforeEach(() => {
  toastError.mockReset();
  toastSuccess.mockReset();
  refresh.mockReset();
  criarCupom.mockReset();
  criarCupom.mockResolvedValue({ ok: true, dados: {} });
  definirCupomAtivo.mockReset();
  definirCupomAtivo.mockResolvedValue({ ok: true, dados: {} });
});
afterEach(() => cleanup());

describe("a lista de cupons", () => {
  it("sem cupom, diz que não há nenhum", () => {
    renderizar(<ListaDeCupons cupons={[]} planos={PLANOS} />);
    expect(screen.getByText("Nenhum cupom cadastrado.")).toBeInTheDocument();
  });

  it("mostra código, desconto em % ou em R$, planos e ciclos (ou todos), validade, usos e ativo", () => {
    const cupons: CupomListado[] = [
      BASE,
      {
        ...BASE,
        id: "22222222-2222-4222-8222-222222222222",
        codigo: "MENOS50",
        tipo: "valor",
        valor: 5000,
        planos: ["pro"],
        ciclos: ["semiannual", "yearly"],
        valido_ate: "2026-12-31T23:59:59-03:00",
        max_usos: 20,
        usos_pagos: 3,
        usos_abertos: 1,
        ativo: false,
        descricao: "Campanha de fim de ano",
      },
    ];
    renderizar(<ListaDeCupons cupons={cupons} planos={PLANOS} />);

    const pct = within(screen.getByTestId("cupom-PCT10"));
    expect(pct.getByText("PCT10")).toBeInTheDocument();
    expect(pct.getByText("10%")).toBeInTheDocument();
    expect(pct.getAllByText("Todos")).toHaveLength(2);
    expect(pct.getByText("Sem validade")).toBeInTheDocument();
    expect(pct.getByText(/0 \/ sem limite/)).toBeInTheDocument();
    expect(pct.getByText("Sim")).toBeInTheDocument();
    expect(pct.getByRole("button", { name: "Desativar" })).toBeInTheDocument();

    const fixo = within(screen.getByTestId("cupom-MENOS50"));
    expect(fixo.getByText(/R\$\s*50,00/)).toBeInTheDocument();
    expect(fixo.getByText("Campanha de fim de ano")).toBeInTheDocument();
    expect(fixo.getByText("Pro")).toBeInTheDocument();
    expect(fixo.getByText("Semestral, Anual")).toBeInTheDocument();
    expect(fixo.getByText("31/12/2026")).toBeInTheDocument();
    expect(fixo.getByText(/3 \/ 20/)).toBeInTheDocument();
    expect(fixo.getByText(/1 em pedidos abertos/)).toBeInTheDocument();
    expect(fixo.getByText("Não")).toBeInTheDocument();
    expect(fixo.getByRole("button", { name: "Ativar" })).toBeInTheDocument();
  });

  it("desativar pede confirmação: cancelar não chama a ação, confirmar chama com o inverso do estado e atualiza a tela", async () => {
    renderizar(<ListaDeCupons cupons={[BASE]} planos={PLANOS} />);

    fireEvent.click(screen.getByTestId("alternar-cupom-PCT10"));
    expect(await screen.findByText(/Desativar este cupom\?/)).toBeInTheDocument();
    expect(definirCupomAtivo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(definirCupomAtivo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("alternar-cupom-PCT10"));
    fireEvent.click(await screen.findByTestId("confirmar-alternar-cupom"));

    await waitFor(() => expect(definirCupomAtivo).toHaveBeenCalledWith({ cupomId: BASE.id, ativo: false }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith("Cupom atualizado.");
  });

  it("cupom inativo: confirmar ativa, e o erro da ação vai ao toast sem fechar a tela", async () => {
    definirCupomAtivo.mockResolvedValue({ ok: false, error: "Confirme a verificação em duas etapas." });
    renderizar(<ListaDeCupons cupons={[{ ...BASE, ativo: false }]} planos={PLANOS} />);

    fireEvent.click(screen.getByTestId("alternar-cupom-PCT10"));
    fireEvent.click(await screen.findByTestId("confirmar-alternar-cupom"));

    await waitFor(() => expect(definirCupomAtivo).toHaveBeenCalledWith({ cupomId: BASE.id, ativo: true }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Confirme a verificação em duas etapas."));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("o formulário de cupom novo", () => {
  const campo = (rotulo: RegExp | string) => screen.getByLabelText(rotulo);

  it("porcentagem, sem plano nem ciclo marcado: manda 'todos' (listas vazias), sem validade nem limite", async () => {
    renderizar(<FormularioDeNovoCupom planos={PLANOS} />);

    fireEvent.change(campo("Código"), { target: { value: "  BEMVINDO10 " } });
    fireEvent.change(campo(/Porcentagem \(de 1 a 99\)/), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("criar-cupom"));

    await waitFor(() => expect(criarCupom).toHaveBeenCalledTimes(1));
    expect(criarCupom).toHaveBeenCalledWith({
      codigo: "BEMVINDO10",
      tipo: "percentual",
      valor: 10,
      planos: [],
      ciclos: [],
      validoAte: null,
      maxUsos: null,
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Cupom criado."));
    expect(refresh).toHaveBeenCalled();
    // Limpa o formulário depois de criar.
    expect((campo("Código") as HTMLInputElement).value).toBe("");
  });

  it("valor fixo com planos, ciclos, validade, limite e descrição: converte reais em centavos e a data para o fim do dia em Brasília", async () => {
    renderizar(<FormularioDeNovoCupom planos={PLANOS} />);

    fireEvent.change(campo("Código"), { target: { value: "MENOS50" } });
    fireEvent.change(campo("Tipo de desconto"), { target: { value: "valor" } });
    fireEvent.change(campo("Valor em reais"), { target: { value: "50,00" } });
    fireEvent.change(campo(/Descrição/), { target: { value: "Campanha de fim de ano" } });
    fireEvent.click(within(screen.getByTestId("cupom-planos")).getByLabelText("Pro"));
    fireEvent.click(within(screen.getByTestId("cupom-ciclos")).getByLabelText("Semestral"));
    fireEvent.click(within(screen.getByTestId("cupom-ciclos")).getByLabelText("Anual"));
    fireEvent.change(campo(/Válido até/), { target: { value: "2026-12-31" } });
    fireEvent.change(campo(/Limite de usos/), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("criar-cupom"));

    await waitFor(() => expect(criarCupom).toHaveBeenCalledTimes(1));
    expect(criarCupom).toHaveBeenCalledWith({
      codigo: "MENOS50",
      tipo: "valor",
      valor: 5000,
      planos: ["pro"],
      ciclos: ["semiannual", "yearly"],
      validoAte: "2026-12-31T23:59:59-03:00",
      maxUsos: 20,
      descricao: "Campanha de fim de ano",
    });
  });

  it("desmarcar um plano marcado tira ele da lista enviada", async () => {
    renderizar(<FormularioDeNovoCupom planos={PLANOS} />);

    fireEvent.change(campo("Código"), { target: { value: "SOPRO" } });
    fireEvent.change(campo(/Porcentagem \(de 1 a 99\)/), { target: { value: "5" } });
    const planos = within(screen.getByTestId("cupom-planos"));
    fireEvent.click(planos.getByLabelText("Pro"));
    fireEvent.click(planos.getByLabelText("Max"));
    fireEvent.click(planos.getByLabelText("Pro"));
    fireEvent.click(screen.getByTestId("criar-cupom"));

    await waitFor(() => expect(criarCupom).toHaveBeenCalledTimes(1));
    expect(criarCupom.mock.calls[0]![0]).toMatchObject({ planos: ["max"] });
  });

  it("entrada inválida não chega ao servidor e a frase aparece em português", () => {
    renderizar(<FormularioDeNovoCupom planos={PLANOS} />);

    // Código curto demais.
    fireEvent.change(campo("Código"), { target: { value: "ab" } });
    fireEvent.click(screen.getByTestId("criar-cupom"));
    expect(screen.getByTestId("cupom-erro")).toHaveTextContent("Código inválido.");

    // Porcentagem fora de 1 a 99.
    fireEvent.change(campo("Código"), { target: { value: "ABC" } });
    fireEvent.change(campo(/Porcentagem \(de 1 a 99\)/), { target: { value: "100" } });
    fireEvent.click(screen.getByTestId("criar-cupom"));
    expect(screen.getByTestId("cupom-erro")).toHaveTextContent("Valor inválido.");

    // Valor fixo ilegível.
    fireEvent.change(campo("Tipo de desconto"), { target: { value: "valor" } });
    fireEvent.change(campo("Valor em reais"), { target: { value: "abc" } });
    fireEvent.click(screen.getByTestId("criar-cupom"));
    expect(screen.getByTestId("cupom-erro")).toHaveTextContent("Valor inválido.");

    // Limite de usos zero.
    fireEvent.change(campo("Valor em reais"), { target: { value: "10,00" } });
    fireEvent.change(campo(/Limite de usos/), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("criar-cupom"));
    expect(screen.getByTestId("cupom-erro")).toHaveTextContent("O limite de usos precisa ser pelo menos 1.");

    expect(criarCupom).not.toHaveBeenCalled();
  });

  it("a recusa da ação (ex.: código repetido) aparece no formulário e no toast, e o que foi digitado fica", async () => {
    criarCupom.mockResolvedValue({ ok: false, error: "Já existe um cupom com este código." });
    renderizar(<FormularioDeNovoCupom planos={PLANOS} />);

    fireEvent.change(campo("Código"), { target: { value: "PCT10" } });
    fireEvent.change(campo(/Porcentagem \(de 1 a 99\)/), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("criar-cupom"));

    await waitFor(() => expect(screen.getByTestId("cupom-erro")).toHaveTextContent("Já existe um cupom com este código."));
    expect(toastError).toHaveBeenCalledWith("Já existe um cupom com este código.");
    expect((campo("Código") as HTMLInputElement).value).toBe("PCT10");
    expect(refresh).not.toHaveBeenCalled();
  });
});
