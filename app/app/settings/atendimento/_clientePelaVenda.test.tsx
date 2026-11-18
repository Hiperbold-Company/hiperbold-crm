/**
 * "Quem já comprou volta pelo funil de clientes" dentro da barra de salvar da
 * tela: o interruptor grava na hora; a janela de pós-venda entra no grupo de
 * salvar (sem botão próprio) e só sai do lugar pela barra.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GrupoDeSalvar } from "@/components/configuracoes/grupo-de-salvar";
import { render } from "@/tests/helpers/render-com-confirmacao";
import { ClientePelaVenda } from "./_clientePelaVenda";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const definir = vi.fn();
vi.mock("@/app/actions/settings/definirClientePelaVenda", () => ({
  definirClientePelaVenda: (entrada: unknown) => definir(entrada),
}));

beforeEach(() => {
  definir.mockReset();
  definir.mockImplementation(async (e: { ligado: boolean; posVendaDias: number }) => ({
    ok: true,
    ligado: e.ligado,
    posVendaDias: e.posVendaDias,
  }));
});

function montar(
  props: Partial<{ ligada: boolean; posVendaDias: number; podeMudar: boolean }> = {},
) {
  return render(
    <GrupoDeSalvar>
      <ClientePelaVenda
        ligada={props.ligada ?? true}
        posVendaDias={props.posVendaDias ?? 30}
        idioma="pt-BR"
        podeMudar={props.podeMudar ?? true}
      />
    </GrupoDeSalvar>,
  );
}

const barra = () => screen.queryByRole("region", { name: "Alterações não salvas" });
const janela = () => screen.getByLabelText("Janela de pós-venda (dias)");

describe("ClientePelaVenda na barra de salvar", () => {
  it("não tem mais o botão Salvar janela; mudar a janela acende a barra e Salvar grava", async () => {
    montar();
    expect(screen.queryByRole("button", { name: "Salvar janela" })).toBeNull();
    expect(barra()).toBeNull();

    fireEvent.change(janela(), { target: { value: "15" } });
    fireEvent.click(within(barra()!).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(barra()).toBeNull());
    expect(definir).toHaveBeenCalledWith({ ligado: true, posVendaDias: 15 });
    expect(screen.getByTestId("pos-venda-dias-estado")).toHaveTextContent("15");
  });

  it("Descartar volta a janela ao último gravado, sem gravar", () => {
    montar();
    fireEvent.change(janela(), { target: { value: "15" } });
    fireEvent.click(within(barra()!).getByRole("button", { name: "Descartar" }));
    expect(janela()).toHaveValue("30");
    expect(barra()).toBeNull();
    expect(definir).not.toHaveBeenCalled();
  });

  it("janela inválida deixa a barra com o Salvar desligado e o motivo", () => {
    montar();
    fireEvent.change(janela(), { target: { value: "400" } });
    expect(within(barra()!).getByRole("button", { name: "Salvar" })).toBeDisabled();
    expect(barra()).toHaveTextContent("Use um número inteiro entre 0 e 365.");
  });

  it("o interruptor grava na hora com a janela GRAVADA, e a digitada continua pendente", async () => {
    montar();
    fireEvent.change(janela(), { target: { value: "15" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"));
    });
    await waitFor(() => expect(definir).toHaveBeenCalledTimes(1));
    expect(definir).toHaveBeenCalledWith({ ligado: false, posVendaDias: 30 });
    expect(janela()).toHaveValue("15");
    expect(barra()).not.toBeNull();
  });

  it("Enter na janela salva pela barra; Enter sem mudança não grava", async () => {
    montar();
    fireEvent.submit(janela().closest("form")!);
    expect(definir).not.toHaveBeenCalled();

    fireEvent.change(janela(), { target: { value: "7" } });
    fireEvent.submit(janela().closest("form")!);
    await waitFor(() => expect(barra()).toBeNull());
    expect(definir).toHaveBeenCalledWith({ ligado: true, posVendaDias: 7 });
  });

  it("sem permissão, o campo fica travado e não há barra", () => {
    montar({ podeMudar: false });
    expect(janela()).toBeDisabled();
    expect(barra()).toBeNull();
  });
});
