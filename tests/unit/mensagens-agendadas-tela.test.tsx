/**
 * O selo "Agendada para…" e o balão no fim da conversa (migration 1017),
 * renderizados de verdade. Dublê só na borda de rede (`apiClient`).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chamadas: Array<{ metodo: string; url: string; corpo?: unknown }> = [];
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(),
    patch: vi.fn(async (url: string, corpo: unknown) => {
      chamadas.push({ metodo: "PATCH", url, corpo });
      return { data: {} };
    }),
    delete: vi.fn(async (url: string) => {
      chamadas.push({ metodo: "DELETE", url });
      return { data: {} };
    }),
  },
}));

import { SeloDeAgendamento } from "@/components/inbox/composer/AgendarMensagem";
import { BalaoAgendado } from "@/components/inbox/MensagensAgendadas";
import type { MensagemAgendada } from "@/hooks/inbox/useMensagensAgendadas";

const FUSO = "America/Sao_Paulo";

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const agendada = (extra: Partial<MensagemAgendada> = {}): MensagemAgendada => ({
  id: "s1",
  conversation_id: "c1",
  created_by: "u1",
  body: "Oi, confirmando amanhã",
  template: null,
  send_at: "2026-11-18T17:30:00.000Z",
  status: "agendada",
  motivo: null,
  message_id: null,
  adiada_ate: null,
  updated_at: "2026-11-17T10:00:00.000Z",
  ...extra,
});

beforeEach(() => {
  chamadas.length = 0;
});

describe("selo do agendamento", () => {
  it("mostra a hora no fuso da organização e o X tira o agendamento", async () => {
    const tirar = vi.fn();
    render(<SeloDeAgendamento quando={new Date("2026-11-18T17:30:00Z")} fuso={FUSO} onTirar={tirar} />);
    expect(screen.getByTestId("selo-de-agendamento").textContent).toContain("Agendada para 18/11 às 14:30");
    await userEvent.click(screen.getByRole("button", { name: "Tirar o agendamento" }));
    expect(tirar).toHaveBeenCalledOnce();
  });
});

describe("balão da mensagem agendada", () => {
  it("mostra hora e texto; Cancelar chama a rota da agendada", async () => {
    comQuery(<BalaoAgendado agendada={agendada()} fuso={FUSO} podeMudar />);
    expect(screen.getByText("Agendada para 18/11 às 14:30")).toBeTruthy();
    expect(screen.getByText("Oi, confirmando amanhã")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(chamadas).toEqual([{ metodo: "DELETE", url: "/api/v1/scheduled-messages/s1" }]));
  });

  it("Editar manda o texto novo com o estado visto", async () => {
    comQuery(<BalaoAgendado agendada={agendada()} fuso={FUSO} podeMudar />);
    await userEvent.click(screen.getByRole("button", { name: "Editar" }));
    const campo = screen.getByLabelText("Texto da mensagem agendada");
    await userEvent.clear(campo);
    await userEvent.type(campo, "Texto novo");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(chamadas).toEqual([
        {
          metodo: "PATCH",
          url: "/api/v1/scheduled-messages/s1",
          corpo: { expected_updated_at: "2026-11-17T10:00:00.000Z", body: "Texto novo" },
        },
      ]),
    );
  });

  it("sem permissão não há botões; falha mostra o motivo e só Dispensar", () => {
    const { rerender } = comQuery(<BalaoAgendado agendada={agendada()} fuso={FUSO} podeMudar={false} />);
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BalaoAgendado
          agendada={agendada({ status: "falhou", motivo: "A conversa não existe mais. Nada foi enviado." })}
          fuso={FUSO}
          podeMudar
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("A conversa não existe mais. Nada foi enviado.");
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dispensar" })).toBeTruthy();
  });
});
