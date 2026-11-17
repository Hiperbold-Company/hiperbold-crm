/**
 * A aba "Templates do WhatsApp" do painel do chat (17/11/2026).
 *
 * Mede: a lista vem da conta DA CONVERSA (`channel_session_id` na URL), com
 * status e categoria; só o aprovado envia, pela cadeia de modelo de sempre; e o
 * "Novo modelo" importa JSON válido para o formulário, recusa o inválido com a
 * mensagem legível e cria na conta da conversa.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), send: vi.fn() }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: h.get, post: h.post } }));
vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: h.send, isPending: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { AbaDeModelosDoWhatsApp } from "./AbaDeModelosDoWhatsApp";

const modelo = (name: string, status: string, category: string) => ({
  name,
  language: "pt_BR",
  status,
  category,
  slots: [{ key: "1", expects: "text", onde: "corpo", valueKey: "body:1" }],
  previews: [],
  components: [{ type: "BODY", text: "Oi {{1}}" }],
  savedValues: {},
  daConexao: true,
});

function renderAba(podeCriar = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AbaDeModelosDoWhatsApp conversationId="conv-1" channelSessionId="sess-b" podeCriar={podeCriar} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockResolvedValue({
    data: {
      waba: "WABA-B",
      templates: [modelo("boas_vindas", "APPROVED", "UTILITY"), modelo("promo", "PENDING", "MARKETING")],
    },
  });
  h.post.mockResolvedValue({ data: { inserted: 1 } });
});

describe("aba de templates do WhatsApp", () => {
  it("pede a lista da conta da conversa e mostra status e categoria", async () => {
    renderAba();
    expect(await screen.findByText("Aprovado")).toBeTruthy();
    expect(h.get).toHaveBeenCalledWith("/api/v1/channels/templates?channel_session_id=sess-b");
    expect(screen.getByText("Em análise")).toBeTruthy();
    expect(screen.getByText("Utilidade")).toBeTruthy();
    expect(screen.getByText("Marketing")).toBeTruthy();
    // O pendente não envia.
    expect((document.querySelector('[data-modelo="promo"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("envia o aprovado com as variáveis pela cadeia de modelo", async () => {
    renderAba();
    await userEvent.click(await screen.findByText(/boas_vindas/));
    const enviar = screen.getByRole("button", { name: "Enviar modelo" });
    expect((enviar as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /\{\{1\}\}/ }), { target: { value: "Ana" } });
    await userEvent.click(enviar);
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: "conv-1",
        type: "template",
        template_name: "boas_vindas",
        template_language: "pt_BR",
        body: "Oi {{1}}",
        template_values: { "body:1": "Ana" },
      }),
      expect.anything(),
    );
  });

  it("sem papel de gerente não oferece Novo modelo", async () => {
    renderAba(false);
    await screen.findByText("Aprovado");
    expect(screen.queryByRole("button", { name: "Novo modelo" })).toBeNull();
  });

  it("importa JSON válido para o formulário e cria na conta da conversa", async () => {
    renderAba();
    await userEvent.click(await screen.findByRole("button", { name: "Novo modelo" }));
    await userEvent.click(screen.getByRole("tab", { name: "JSON" }));
    const json = {
      name: "aviso_pedido",
      language: "pt_BR",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Seu pedido {{1}} saiu.", example: { body_text: [["123"]] } }],
    };
    fireEvent.change(screen.getByRole("textbox", { name: "JSON do modelo" }), { target: { value: JSON.stringify(json) } });
    await userEvent.click(screen.getByRole("button", { name: "Importar para o formulário" }));
    expect(screen.getByRole("tab", { name: "Formulário" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByRole("textbox", { name: "Nome do modelo" }) as HTMLInputElement).value).toBe("aviso_pedido");

    await userEvent.click(screen.getByRole("button", { name: "Enviar para revisão" }));
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    expect(h.post).toHaveBeenCalledWith(
      "/api/v1/channels/templates",
      expect.objectContaining({
        acao: "criar",
        name: "aviso_pedido",
        category: "UTILITY",
        channel_session_id: "sess-b",
        components: [{ type: "BODY", text: "Seu pedido {{1}} saiu.", example: { body_text: [["123"]] } }],
      }),
    );
  });

  it("recusa JSON inválido com a mensagem legível e o campo", async () => {
    renderAba();
    await userEvent.click(await screen.findByRole("button", { name: "Novo modelo" }));
    await userEvent.click(screen.getByRole("tab", { name: "JSON" }));
    fireEvent.change(screen.getByRole("textbox", { name: "JSON do modelo" }), {
      target: { value: JSON.stringify({ name: "x", language: "pt_BR", category: "PROMO", components: [] }) },
    });
    await userEvent.click(screen.getByRole("button", { name: "Importar para o formulário" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Categoria inválida.*\(category\)/);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("exporta o que está no formulário como JSON da Meta", async () => {
    renderAba();
    await userEvent.click(await screen.findByRole("button", { name: "Novo modelo" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nome do modelo" }), { target: { value: "lembrete" } });
    await userEvent.click(screen.getByRole("tab", { name: "JSON" }));
    const exportado = JSON.parse((screen.getByRole("textbox", { name: "JSON do modelo" }) as HTMLTextAreaElement).value);
    expect(exportado).toMatchObject({ name: "lembrete", language: "pt_BR", category: "UTILITY" });
  });
});
