import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnsinarAgenteButton } from "./EnsinarAgenteButton";
import type { EstadoDoEnsino } from "@/lib/ai/rag/conversa-que-ensina";

/**
 * O botão e o hook rodam DE VERDADE; o que se troca é só a rede (`fetch`), que
 * responde como a rota `usable-for-rag`. Assim o teste mede o que a pessoa vê
 * (rótulo, estado pressionado, texto do diálogo) e o que vai para o servidor.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Chamada = { method: string; url: string; body: unknown };
let chamadas: Chamada[];
let servidor: EstadoDoEnsino;

function base(): EstadoDoEnsino {
  return {
    conversation_id: "conv-1",
    usable_for_rag: false,
    usable_for_rag_marked_at: null,
    rag_review_status: null,
    pode_marcar: true,
  };
}

beforeEach(() => {
  chamadas = [];
  servidor = base();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      chamadas.push({ method: init.method ?? "GET", url, body });
      if (init.method === "POST") {
        const enabled = (body as { enabled: boolean }).enabled;
        servidor = {
          ...servidor,
          usable_for_rag: enabled,
          usable_for_rag_marked_at: enabled ? "2026-10-22T12:00:00Z" : null,
        };
      }
      return new Response(JSON.stringify({ data: servidor }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderizar(encerrada = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EnsinarAgenteButton conversationId="conv-1" encerrada={encerrada} />
    </QueryClientProvider>,
  );
}

describe("EnsinarAgenteButton", () => {
  it("conversa aberta: não mostra nada e não consulta o servidor", () => {
    renderizar(false);
    expect(screen.queryByTestId("ensinar-o-agente")).toBeNull();
    expect(chamadas).toHaveLength(0);
  });

  it("marca pela rota, explica o que acontece e passa a mostrar o estado marcado", async () => {
    const user = userEvent.setup();
    renderizar();

    const botao = await screen.findByRole("button", { name: "Usar para ensinar o agente" });
    await waitFor(() => expect(botao).toBeEnabled());
    expect(botao).toHaveAttribute("aria-pressed", "false");

    await user.click(botao);
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText(/próxima rodada noturna, sem dados pessoais/)).toBeTruthy();
    expect(chamadas.filter((c) => c.method === "POST")).toHaveLength(0);

    await user.click(within(dialogo).getByRole("button", { name: "Usar para ensinar" }));

    const marcado = await screen.findByRole("button", { name: "Ensinando o agente" });
    expect(marcado).toHaveAttribute("aria-pressed", "true");
    const post = chamadas.find((c) => c.method === "POST");
    expect(post).toEqual({
      method: "POST",
      url: "/api/v1/conversations/conv-1/usable-for-rag",
      body: { enabled: true },
    });
  });

  it("já indexada: desmarcar diz que o que o agente aprendeu NÃO é apagado", async () => {
    servidor = {
      ...base(),
      usable_for_rag: true,
      usable_for_rag_marked_at: "2026-10-20T12:00:00Z",
      rag_review_status: "ingested",
    };
    const user = userEvent.setup();
    renderizar();

    const botao = await screen.findByRole("button", { name: "Ensinando o agente" });
    await user.click(botao);
    const dialogo = await screen.findByRole("alertdialog");
    expect(
      within(dialogo).getByText(/Retirar a marcação não apaga o que ele já aprendeu/),
    ).toBeTruthy();

    await user.click(within(dialogo).getByRole("button", { name: "Retirar a marcação" }));
    await screen.findByRole("button", { name: "Usar para ensinar o agente" });
    expect(chamadas.find((c) => c.method === "POST")?.body).toEqual({ enabled: false });
  });
});
