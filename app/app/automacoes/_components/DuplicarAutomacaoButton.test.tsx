/**
 * Botão «Duplicar» do cartão em Automações: chama a rota de duplicar do fluxo,
 * põe a cópia na lista da superfície certa (automação tem chave própria no cache)
 * e recarrega as props do servidor (follow-ups chegam por elas). Teto do plano
 * cheio desliga o botão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn() } }));

import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { followupFlowsListQueryKey } from "@/hooks/followup/useFollowupFlows";
import { DuplicarAutomacaoButton } from "./DuplicarAutomacaoButton";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COPIA = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Atribuir (cópia)",
  status: "draft",
  active_version_id: null,
  handoff_policy: "pause",
  updated_at: "2026-11-18T12:00:00Z",
};
const post = vi.mocked(apiClient.post);

function montar(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  return qc;
}

beforeEach(() => vi.clearAllMocks());

describe("DuplicarAutomacaoButton", () => {
  it("automação: chama a rota, a cópia entra na lista de automações e a tela recarrega", async () => {
    post.mockResolvedValue({ data: COPIA });
    const qc = montar(<DuplicarAutomacaoButton flowId={ID} tipo="automacao" />);
    qc.setQueryData([...followupFlowsListQueryKey, "automacao"], []);
    fireEvent.click(screen.getByTestId("duplicar-automacao"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(`/api/v1/ai/followup-flows/${ID}/duplicate`, {});
    expect(qc.getQueryData([...followupFlowsListQueryKey, "automacao"])).toEqual([COPIA]);
    // A lista de follow-ups não recebe a automação.
    expect(qc.getQueryData(followupFlowsListQueryKey)).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith("Automação duplicada. A cópia está desligada.");
  });

  it("follow-up: a cópia vai para a lista de follow-ups", async () => {
    post.mockResolvedValue({ data: COPIA });
    const qc = montar(<DuplicarAutomacaoButton flowId={ID} tipo="followup" />);
    fireEvent.click(screen.getByTestId("duplicar-automacao"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(qc.getQueryData(followupFlowsListQueryKey)).toEqual([COPIA]);
    expect(toast.success).toHaveBeenCalledWith("Follow-up duplicado. A cópia está desligada.");
  });

  it("teto do plano cheio: botão desligado, nada é chamado", () => {
    montar(<DuplicarAutomacaoButton flowId={ID} tipo="automacao" bloqueado />);
    const botao = screen.getByTestId("duplicar-automacao");
    expect(botao).toBeDisabled();
    fireEvent.click(botao);
    expect(post).not.toHaveBeenCalled();
  });
});
