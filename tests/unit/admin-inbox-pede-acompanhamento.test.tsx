/**
 * Caixa de entrada da Plataforma: 403 `support_session_required` explica que é
 * preciso abrir um acompanhamento; qualquer outro erro segue como falha genérica.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiClient: { get: h.get } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));
vi.mock("@/hooks/useAdminInboxRealtime", () => ({ useAdminInboxRealtime: () => undefined }));

import { ApiError } from "@/lib/api/types";
import { InboxList } from "@/app/admin/(protected)/inbox/_components/InboxList";

afterEach(() => cleanup());

function montar() {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cliente}>
      <InboxList />
    </QueryClientProvider>,
  );
}

describe("Caixa da Plataforma sem acompanhamento", () => {
  it("403 support_session_required: explica e não mostra a falha genérica", async () => {
    h.get.mockRejectedValue(new ApiError(403, "support_session_required", undefined, "r1"));
    montar();
    expect(await screen.findByText("Abra um acompanhamento para ver as conversas")).toBeInTheDocument();
    expect(screen.getByText(/só aparecem enquanto um acompanhamento dela estiver aberto/)).toBeInTheDocument();
    expect(screen.queryByText("Falha ao carregar conversas.")).toBeNull();
    expect(screen.getByRole("link", { name: "Ir para as empresas" })).toHaveAttribute("href", "/admin/tenants");
  });

  it("500: continua 'Falha ao carregar conversas.'", async () => {
    h.get.mockRejectedValue(new ApiError(500, "internal_error", undefined, "r2"));
    montar();
    expect(await screen.findByText("Falha ao carregar conversas.")).toBeInTheDocument();
    expect(screen.queryByText("Abra um acompanhamento para ver as conversas")).toBeNull();
  });
});
