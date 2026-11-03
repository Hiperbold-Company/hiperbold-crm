/**
 * Limite de Conexões do plano (D-188) na aba Redes sociais. Conectar conta NOVA
 * cria canal, então "Conectar" fica travado com o motivo; "Reconectar" renova
 * uma conta que já existe e não é barrado pelo teto.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const getMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...a: unknown[]) => getMock(...a), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("aba=sociais"),
  usePathname: () => "/app/connections",
}));

import { RedesSociaisClient } from "@/components/connections/RedesSociaisClient";

const ESTADO = {
  data: {
    configurado: { instagram: true, messenger: true },
    contas: [
      {
        id: "acc-1",
        plataforma: "instagram",
        nome: "Empresa",
        usuario: "empresa",
        conectado_em: "2026-10-30T12:00:00Z",
        token_expira_em: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        status: "ativo",
      },
    ],
  },
};

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("bloqueio do plano no botão «Conectar»", () => {
  it("com o bloqueio valendo, Conectar fica desabilitado e mostra o motivo; Reconectar segue", async () => {
    getMock.mockResolvedValue(ESTADO);
    render(
      comQuery(
        <RedesSociaisClient
          bloqueio={{ desabilitado: true, motivo: "3 de 3 conexões do plano Starter", suspensa: false }}
        />,
      ),
    );

    const instagram = await screen.findByTestId("cartao-instagram");
    const botao = within(instagram).getByRole("button", { name: "Conectar" });
    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute("title", "3 de 3 conexões do plano Starter");
    expect(within(instagram).getByText("3 de 3 conexões do plano Starter")).toBeInTheDocument();
    expect(within(instagram).getByRole("link", { name: "Reconectar" })).toBeInTheDocument();
  });

  it("sem a prop `bloqueio`, Conectar é um link para a conexão", async () => {
    getMock.mockResolvedValue(ESTADO);
    render(comQuery(<RedesSociaisClient />));

    const instagram = await screen.findByTestId("cartao-instagram");
    expect(within(instagram).getByRole("link", { name: "Conectar" })).toBeInTheDocument();
    expect(within(instagram).queryByRole("button", { name: "Conectar" })).toBeNull();
  });
});
