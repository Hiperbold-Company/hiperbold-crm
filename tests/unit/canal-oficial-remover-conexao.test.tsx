/**
 * "Remover conexão" no cartão da conexão oficial (Meta).
 *
 * Dois cliques, como nas conexões por QR: o primeiro só pede confirmação, o segundo
 * dispara `DELETE /api/v1/channel-sessions/<id>`. O botão some para quem não é admin
 * (a rota é quem barra de verdade).
 *
 * Roda com: npx vitest run tests/unit/canal-oficial-remover-conexao.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  podeRemover: true,
  apagar: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermissionSeHouverSessao: () => h.podeRemover }));
vi.mock("@/lib/api/client", () => ({ apiClient: { delete: h.apagar } }));
vi.mock("@/hooks/channels/useOfficialChannel", () => ({
  useOfficialChannel: () => ({
    isPending: false,
    data: {
      data: {
        connected: true,
        displayName: "Comercial",
        phoneNumber: "+55 11 99999-0000",
        status: "connected",
        hasToken: true,
        wabaId: "999",
        phoneNumberId: "111",
        channel_session_id: "sessao-oficial-1",
        labelColor: null,
        webhook: null,
      },
    },
  }),
  useConnectOfficialChannel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarWebhookOficial: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/connections/ConectarComAMeta", () => ({ ConectarComAMeta: () => null }));
vi.mock("@/components/connections/NumeroOficialCard", () => ({ NumeroOficialCard: () => null }));
vi.mock("@/components/connections/ChannelAiAccess", () => ({ ChannelAiAccess: () => null }));
vi.mock("@/components/connections/ParaIntegrar", () => ({ ParaIntegrar: () => null }));
vi.mock("@/components/connections/RenomearConexao", () => ({ RenomearConexao: () => null }));
vi.mock("@/components/connections/AvisoDeLimiteDeConexoes", () => ({ AvisoDeLimiteDeConexoes: () => null }));

import { CanalOficialClient } from "@/components/connections/CanalOficialClient";

function montar() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <CanalOficialClient />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.podeRemover = true;
  h.apagar.mockReset();
  h.apagar.mockResolvedValue({ data: {} });
  Object.values(h.toast).forEach((f) => f.mockReset());
});

describe("CanalOficialClient: Remover conexão", () => {
  it("um clique só pede confirmação e não dispara o DELETE", () => {
    montar();
    const botao = screen.getByTestId("btn-remover-conexao-oficial");
    expect(botao.textContent).toBe("Remover conexão");
    fireEvent.click(botao);
    expect(botao.textContent).toBe("Clique de novo para remover");
    expect(h.apagar).not.toHaveBeenCalled();
  });

  it("segundo clique dispara o DELETE no id do canal oficial", async () => {
    montar();
    const botao = screen.getByTestId("btn-remover-conexao-oficial");
    fireEvent.click(botao);
    fireEvent.click(botao);
    await waitFor(() => expect(h.apagar).toHaveBeenCalledTimes(1));
    expect(h.apagar).toHaveBeenCalledWith("/api/v1/channel-sessions/sessao-oficial-1");
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
  });

  it("erro da API vira toast com a mensagem da rota", async () => {
    h.apagar.mockRejectedValue(new Error("Confirme a verificação em duas etapas."));
    montar();
    const botao = screen.getByTestId("btn-remover-conexao-oficial");
    fireEvent.click(botao);
    fireEvent.click(botao);
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Confirme a verificação em duas etapas."));
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it("quem não é admin não vê o botão", () => {
    h.podeRemover = false;
    montar();
    expect(screen.queryByTestId("btn-remover-conexao-oficial")).toBeNull();
  });
});
