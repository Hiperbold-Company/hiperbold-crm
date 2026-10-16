/**
 * As telas do pedido de reembolso e do motivo de cancelamento (migration 0957), pelo que a pessoa vê e o que a
 * tela manda: o diálogo de cancelar exige o motivo (e só então habilita), "Solicitar reembolso" mostra o
 * pagamento, o aviso dos 7 dias e o prazo de 3 dias úteis, e a lista do admin mostra pedidos com as duas saídas.
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

const cancelarAssinatura = vi.fn();
vi.mock("@/app/actions/settings/compraDoPlano", () => ({ cancelarAssinatura: (...a: unknown[]) => cancelarAssinatura(...a) }));
const solicitarReembolso = vi.fn();
vi.mock("@/app/actions/settings/reembolso", () => ({ solicitarReembolso: (...a: unknown[]) => solicitarReembolso(...a) }));
const resolverPedidoDeReembolso = vi.fn();
vi.mock("@/app/actions/admin/reembolsos", () => ({
  resolverPedidoDeReembolso: (...a: unknown[]) => resolverPedidoDeReembolso(...a),
}));

import { ListaDePedidosDeReembolso } from "@/app/admin/(protected)/sistema/reembolsos/_client";
import type { PedidoDeReembolsoListado } from "@/app/actions/admin/reembolsos";
import { BotaoCancelarAssinatura } from "@/app/app/settings/plano/_botao-cancelar-assinatura";
import { BotaoSolicitarReembolso } from "@/app/app/settings/plano/_botao-solicitar-reembolso";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

function renderizar(ui: React.ReactElement, locale: "pt-BR" | "es" = "pt-BR") {
  return render(<IdiomaProvider locale={locale}>{ui}</IdiomaProvider>);
}

beforeEach(() => {
  for (const m of [toastError, toastSuccess, refresh, cancelarAssinatura, solicitarReembolso, resolverPedidoDeReembolso]) m.mockReset();
  cancelarAssinatura.mockResolvedValue({ tipo: "ok", cancelAtPeriodEnd: true });
  solicitarReembolso.mockResolvedValue({ tipo: "ok" });
  resolverPedidoDeReembolso.mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

describe("cancelar a assinatura pede o motivo", () => {
  async function abrir() {
    renderizar(<BotaoCancelarAssinatura />);
    fireEvent.click(screen.getByTestId("cancelar-assinatura-cliente"));
    return screen.findByTestId("motivo-do-cancelamento");
  }

  it("lista os cinco motivos e o botão de confirmar só habilita com um deles escolhido", async () => {
    const campo = (await abrir()) as HTMLSelectElement;
    const opcoes = within(campo).getAllByRole("option").map((o) => o.textContent);
    expect(opcoes).toEqual(["Escolha um motivo", "Não usei como esperava", "Preço", "Faltou um recurso", "Contratei por engano", "Outro"]);
    expect(screen.getByTestId("confirmar-cancelar-assinatura-cliente")).toBeDisabled();

    fireEvent.change(campo, { target: { value: "preco" } });
    expect(screen.getByTestId("confirmar-cancelar-assinatura-cliente")).toBeEnabled();
    expect(cancelarAssinatura).not.toHaveBeenCalled();
  });

  it("confirmar manda o motivo e o texto livre à ação, e atualiza a tela", async () => {
    const campo = await abrir();
    fireEvent.change(campo, { target: { value: "faltou_recurso" } });
    fireEvent.change(screen.getByTestId("detalhe-do-cancelamento"), { target: { value: "  relatórios melhores " } });
    fireEvent.click(screen.getByTestId("confirmar-cancelar-assinatura-cliente"));

    await waitFor(() => expect(cancelarAssinatura).toHaveBeenCalledWith({ motivo: "faltou_recurso", detalhe: "relatórios melhores" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith("Cancelamento registrado.");
  });

  it("sem texto livre, manda só o motivo; erro da ação vai ao toast sem atualizar", async () => {
    cancelarAssinatura.mockResolvedValue({ tipo: "erro", mensagem: "Não foi possível agora." });
    const campo = await abrir();
    fireEvent.change(campo, { target: { value: "outro" } });
    fireEvent.click(screen.getByTestId("confirmar-cancelar-assinatura-cliente"));
    await waitFor(() => expect(cancelarAssinatura).toHaveBeenCalledWith({ motivo: "outro" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Não foi possível agora."));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("Solicitar reembolso", () => {
  const PAGAMENTO = { paymentId: "11111111-1111-4111-8111-111111111111", amountCents: 34900, paidAt: "2026-10-13T15:00:00Z", plano: "Pro" };

  it("o diálogo mostra o pagamento, a garantia de 7 dias e o prazo de 3 dias úteis, sem perguntar o motivo", async () => {
    renderizar(<BotaoSolicitarReembolso pagamento={PAGAMENTO} />);
    fireEvent.click(screen.getByTestId("solicitar-reembolso"));
    expect(await screen.findByText("Você está dentro do prazo de arrependimento de 7 dias: o reembolso é integral.")).toBeInTheDocument();
    const resumo = within(screen.getByTestId("reembolso-pagamento"));
    expect(resumo.getByText("Pro")).toBeInTheDocument();
    expect(resumo.getByText(/R\$\s*349,00/)).toBeInTheDocument();
    expect(resumo.getByText(/13\/10\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/Respondemos em até 3 dias úteis\. Assim que o estorno for concluído, avisamos por e-mail\./)).toBeInTheDocument();
    expect(screen.queryByTestId("motivo-do-cancelamento")).toBeNull();
    expect(screen.queryByText(/analisa cada pedido/)).toBeNull();
  });

  it("confirmar manda o pagamento (e a observação, se houver) e atualiza a tela", async () => {
    renderizar(<BotaoSolicitarReembolso pagamento={PAGAMENTO} />);
    fireEvent.click(screen.getByTestId("solicitar-reembolso"));
    fireEvent.change(await screen.findByTestId("observacao-do-reembolso"), { target: { value: " obrigado " } });
    fireEvent.click(screen.getByTestId("confirmar-solicitar-reembolso"));
    await waitFor(() => expect(solicitarReembolso).toHaveBeenCalledWith({ paymentId: PAGAMENTO.paymentId, detalhe: "obrigado" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith("Pedido de reembolso enviado.");
  });

  it("sem observação manda só o pagamento; a recusa do servidor (fora do prazo) vai ao toast", async () => {
    solicitarReembolso.mockResolvedValue({
      tipo: "erro",
      mensagem: "O prazo de 7 dias de garantia já passou, então não é possível pedir reembolso desta cobrança.",
    });
    renderizar(<BotaoSolicitarReembolso pagamento={PAGAMENTO} />);
    fireEvent.click(screen.getByTestId("solicitar-reembolso"));
    fireEvent.click(await screen.findByTestId("confirmar-solicitar-reembolso"));
    await waitFor(() => expect(solicitarReembolso).toHaveBeenCalledWith({ paymentId: PAGAMENTO.paymentId }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });

  it("em espanhol", async () => {
    renderizar(<BotaoSolicitarReembolso pagamento={PAGAMENTO} />, "es");
    fireEvent.click(screen.getByTestId("solicitar-reembolso"));
    expect(await screen.findByText(/3 días hábiles/)).toBeInTheDocument();
  });
});

describe("a lista do admin", () => {
  const BASE: PedidoDeReembolsoListado = {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: "o1",
    empresa: "Empresa A",
    amountCents: 34900,
    paidAt: "2026-10-13T15:00:00Z",
    dentro7Dias: true,
    motivo: "preco",
    detalhe: "obrigado",
    status: "pendente",
    createdAt: "2026-10-15T15:00:00Z",
    resolvedAt: null,
    asaasPaymentId: "pay_abc123",
    linkDoAsaas: "https://www.asaas.com/i/abc123",
  };

  it("sem pedidos, diz que não há nenhum", () => {
    renderizar(<ListaDePedidosDeReembolso pedidos={[]} />);
    expect(screen.getByText("Nenhum pedido de reembolso.")).toBeInTheDocument();
  });

  it("mostra empresa, valor, data, 7 dias, motivo, link do Asaas e as duas saídas só no pendente", () => {
    const resolvido: PedidoDeReembolsoListado = { ...BASE, id: "44444444-4444-4444-8444-444444444444", status: "concluido", resolvedAt: "2026-10-16T10:00:00Z", dentro7Dias: false };
    renderizar(<ListaDePedidosDeReembolso pedidos={[BASE, resolvido]} />);
    const l = within(screen.getByTestId(`reembolso-${BASE.id}`));
    expect(l.getByText("Empresa A")).toBeInTheDocument();
    expect(l.getByText(/R\$\s*349,00/)).toBeInTheDocument();
    expect(l.getByText("13/10/2026")).toBeInTheDocument();
    expect(l.getByText("Sim")).toBeInTheDocument();
    expect(l.getByText("Preço")).toBeInTheDocument();
    expect(l.getByText("obrigado")).toBeInTheDocument();
    expect(l.getByRole("link", { name: "Abrir no Asaas" })).toHaveAttribute("href", "https://www.asaas.com/i/abc123");
    expect(l.getByText("Pendente")).toBeInTheDocument();
    expect(l.getByRole("button", { name: "Marcar como concluído" })).toBeInTheDocument();
    expect(l.getByRole("button", { name: "Recusar" })).toBeInTheDocument();

    const r = within(screen.getByTestId(`reembolso-${resolvido.id}`));
    expect(r.getByText("Concluído")).toBeInTheDocument();
    expect(r.queryByRole("button")).toBeNull();
  });

  it("recusar pede confirmação e manda o pedido com status recusado", async () => {
    renderizar(<ListaDePedidosDeReembolso pedidos={[BASE]} />);
    fireEvent.click(screen.getByTestId(`recusar-reembolso-${BASE.id}`));
    expect(await screen.findByText("Recusar o pedido de reembolso?")).toBeInTheDocument();
    expect(resolverPedidoDeReembolso).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(`confirmar-reembolso-${BASE.id}`));
    await waitFor(() => expect(resolverPedidoDeReembolso).toHaveBeenCalledWith({ pedidoId: BASE.id, status: "recusado" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith("Pedido atualizado.");
  });

  it("marcar como concluído manda status concluido; erro da ação vai ao toast", async () => {
    resolverPedidoDeReembolso.mockResolvedValue({ ok: false, error: "Este pedido já foi resolvido." });
    renderizar(<ListaDePedidosDeReembolso pedidos={[BASE]} />);
    fireEvent.click(screen.getByTestId(`concluir-reembolso-${BASE.id}`));
    fireEvent.click(await screen.findByTestId(`confirmar-reembolso-${BASE.id}`));
    await waitFor(() => expect(resolverPedidoDeReembolso).toHaveBeenCalledWith({ pedidoId: BASE.id, status: "concluido" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Este pedido já foi resolvido."));
    expect(refresh).not.toHaveBeenCalled();
  });
});
