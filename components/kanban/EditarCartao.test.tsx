import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// app/app/pipelines/[id]/trocar-funil.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const patch = vi.hoisted(() => vi.fn(async () => ({ data: {} })));
vi.mock("@/lib/api/client", () => ({ apiClient: { patch } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ContatoNoCard } from "./ContatoNoCard";
import { BotaoEditarCartao, EditarCartaoDialog } from "./EditarCartao";

afterEach(cleanup);

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const ordem = (raiz: HTMLElement) =>
  Array.from(raiz.querySelectorAll("[data-linha-do-cartao]")).map((e) => e.getAttribute("data-linha-do-cartao"));

const lead = {
  contact_phone: "+5511999998888",
  contact_email: "ana@exemplo.com",
  source: "site",
  conversa: { id: "c1", preview: "Quero o orçamento", last_message_at: null, unread: 0 },
  custom_fields: { utm_campaign: "turmas-janeiro", utm_source: "" },
};

describe("ContatoNoCard — as linhas do cartão", () => {
  it("⭐ etiquetas: uma linha com a união (separada por ·), tooltip com todas; some quando vazia", () => {
    const { container, rerender } = render(
      <ContatoNoCard
        lead={{ tags: ["VIP"], contact_tags: ["vip", "indicação"], conversation_tags: ["urgente"], contact_links: [] }}
        linhas={["etiquetas"]}
      />,
    );
    const linha = container.querySelector('[data-linha-do-cartao="etiquetas"]')!;
    expect(linha.textContent).toContain("VIP · indicação · urgente");
    expect(linha.getAttribute("title")).toContain("VIP · indicação · urgente");
    rerender(<ContatoNoCard lead={{ tags: [], contact_links: [] }} linhas={["etiquetas"]} />);
    expect(container.querySelector('[data-linha-do-cartao="etiquetas"]')).toBeNull();
  });

  it("⭐ padrão (sem configuração) = o card de hoje: última mensagem e depois telefone, sem e-mail", () => {
    const { container } = render(<ContatoNoCard lead={lead} />);
    expect(ordem(container)).toEqual(["ultima_mensagem", "telefone"]);
    expect(screen.getByText("Quero o orçamento")).toBeInTheDocument();
    expect(screen.getByText("+5511999998888")).toBeInTheDocument();
    expect(screen.queryByText("ana@exemplo.com")).toBeNull();
  });

  it("⭐ mostra as linhas NA ORDEM escolhida, e a linha de valor vazio some (sem traço)", () => {
    const { container } = render(
      <ContatoNoCard lead={lead} linhas={["utm_campaign", "email", "utm_source", "cargo", "telefone"]} />,
    );
    expect(ordem(container)).toEqual(["utm_campaign", "email", "telefone"]);
    expect(container.textContent).not.toContain("—");
    // A UTM com rótulo curto: "campaign turmas-janeiro", com a explicação no title.
    const utm = container.querySelector('[data-linha-do-cartao="utm_campaign"]')!;
    expect(utm.textContent).toBe("campaignturmas-janeiro");
    expect(utm.getAttribute("title")).toContain("utm_campaign");
  });

  it("⭐ conversa com não lidas e prévia vazia: a linha fica, com o contador e \"conversa sem mensagens\", sem clique", () => {
    const { container } = render(
      <ContatoNoCard lead={{ conversa: { id: "c", preview: null, last_message_at: null, unread: 4 } }} />,
    );
    expect(ordem(container)).toEqual(["ultima_mensagem"]);
    expect(screen.getByText("conversa sem mensagens")).toBeInTheDocument();
    expect(screen.getByLabelText("4 sem ler")).toHaveTextContent("4");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("⭐ sem a linha \"Última mensagem\" configurada, o contador de não lidas não aparece", () => {
    render(
      <ContatoNoCard
        lead={{ contact_phone: "+5511999998888", conversa: { id: "c", preview: "Oi", last_message_at: null, unread: 5 } }}
        linhas={["telefone"]}
      />,
    );
    expect(screen.queryByLabelText(/sem ler/)).toBeNull();
    // controle: com a linha, o contador aparece
    cleanup();
    render(
      <ContatoNoCard
        lead={{ contact_phone: "+5511999998888", conversa: { id: "c", preview: "Oi", last_message_at: null, unread: 5 } }}
        linhas={["telefone", "ultima_mensagem"]}
      />,
    );
    expect(screen.getByLabelText("5 sem ler")).toHaveTextContent("5");
  });

  it("prévia vazia e SEM não lidas: a linha some", () => {
    const { container } = render(
      <ContatoNoCard lead={{ conversa: { id: "c", preview: null, last_message_at: null, unread: 0 } }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("zero linhas e sem links: o bloco não renderiza nada", () => {
    const { container } = render(<ContatoNoCard lead={lead} linhas={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("BotaoEditarCartao — só gerente e administrador", () => {
  it.each(["viewer", "agent", "ai_operator"] as const)("⭐ %s: o botão não existe", (role) => {
    render(<BotaoEditarCartao role={role} pipelineId="p1" linhas={["telefone"]} />);
    expect(screen.queryByRole("button", { name: /Editar cartão/ })).toBeNull();
  });

  it.each(["manager", "admin"] as const)("%s: o botão existe e abre o modal", async (role) => {
    comQuery(<BotaoEditarCartao role={role} pipelineId="p1" linhas={["telefone"]} />);
    await userEvent.click(screen.getByRole("button", { name: /Editar cartão/ }));
    expect(await screen.findByTestId("editar-cartao-dialog")).toBeInTheDocument();
  });
});

describe("EditarCartaoDialog", () => {
  it("⭐ a prévia muda ao trocar o campo de uma linha", async () => {
    comQuery(<EditarCartaoDialog pipelineId="p1" linhas={["telefone"]} onFechar={() => undefined} />);
    const previa = screen.getByTestId("previa-do-cartao");
    expect(ordem(previa)).toEqual(["telefone"]);

    await userEvent.click(screen.getByRole("combobox", { name: "Linha 2" }));
    await userEvent.click(await screen.findByRole("option", { name: "utm_campaign" }));

    expect(ordem(previa)).toEqual(["telefone", "utm_campaign"]);
    expect(within(previa).getByText("turmas-janeiro")).toBeInTheDocument();
  });

  it("⭐ a opção Etiquetas existe no Select e a prévia mostra a união de exemplo", async () => {
    comQuery(<EditarCartaoDialog pipelineId="p1" linhas={["telefone"]} onFechar={() => undefined} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Linha 2" }));
    await userEvent.click(await screen.findByRole("option", { name: "Etiquetas" }));
    const previa = screen.getByTestId("previa-do-cartao");
    expect(ordem(previa)).toEqual(["telefone", "etiquetas"]);
    expect(within(previa).getByText(/Cliente VIP · Indicação · Orçamento/)).toBeInTheDocument();
  });

  it("subir troca a ordem; Salvar manda só as linhas escolhidas, na ordem", async () => {
    const onFechar = vi.fn();
    comQuery(<EditarCartaoDialog pipelineId="p1" linhas={["telefone", "email"]} onFechar={onFechar} />);
    await userEvent.click(screen.getByRole("button", { name: "Subir linha 2" }));
    expect(ordem(screen.getByTestId("previa-do-cartao"))).toEqual(["email", "telefone"]);
    await userEvent.click(screen.getByTestId("editar-cartao-salvar"));
    expect(patch).toHaveBeenLastCalledWith("/api/v1/pipelines/p1/card-lines", { card_lines: ["email", "telefone"] });
    expect(onFechar).toHaveBeenCalled();
  });

  it("⭐ Voltar ao padrão mostra o padrão e Salvar manda null (a rota apaga a chave)", async () => {
    comQuery(<EditarCartaoDialog pipelineId="p1" linhas={["utm_source"]} onFechar={() => undefined} />);
    await userEvent.click(screen.getByTestId("editar-cartao-padrao"));
    expect(ordem(screen.getByTestId("previa-do-cartao"))).toEqual(["ultima_mensagem", "telefone"]);
    await userEvent.click(screen.getByTestId("editar-cartao-salvar"));
    expect(patch).toHaveBeenLastCalledWith("/api/v1/pipelines/p1/card-lines", { card_lines: null });
  });

  it("Cancelar fecha sem gravar", async () => {
    patch.mockClear();
    const onFechar = vi.fn();
    comQuery(<EditarCartaoDialog pipelineId="p1" linhas={["telefone"]} onFechar={onFechar} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onFechar).toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});
