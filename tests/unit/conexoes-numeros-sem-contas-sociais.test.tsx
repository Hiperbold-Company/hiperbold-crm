/**
 * A lista de NÚMEROS de WhatsApp não mostra conta de rede social.
 *
 * O filtro excluía só o provider social intermediado; a conta do Instagram ou
 * do Messenger pela conexão oficial (`meta_social`) aparecia como "número
 * conectado", com Reconectar por QR e Excluir pelo transporte do WhatsApp —
 * botões que não servem para ela. Cada rede tem a aba própria.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";
import { ehCanalSocial } from "@/lib/channels/capabilities";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/channels/usePacingKnobs", () => ({ usePacingKnobs: () => ({ data: { items: [] } }) }));
vi.mock("@/components/connections/AntiBanSheet", () => ({ AntiBanSheet: () => null }));

const listagem: { data: ChannelSession[]; isLoading: boolean; isError: boolean; schemaOutdated: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
  schemaOutdated: false,
};
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => listagem };
});

import { ConnectionsClient } from "@/components/connections/ConnectionsClient";

function canal(over: Partial<ChannelSession> & { provider?: string }): ChannelSession {
  return {
    id: "c",
    waha_session_name: null,
    display_name: "Canal",
    phone_number: null,
    status: "WORKING",
    status_reason: null,
    last_health_check_at: null,
    last_status_change_at: null,
    daily_message_limit: 250,
    is_warmup_complete: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  } as ChannelSession;
}

afterEach(() => cleanup());

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);

describe("números de WhatsApp sem as contas sociais", () => {
  it("conta do Instagram oficial e do social intermediado ficam fora; o número fica", () => {
    listagem.data = [
      canal({ id: "wa", provider: "waha", display_name: "Vendas", waha_session_name: "org_1_a", phone_number: "5511999999999" }),
      canal({ id: "ig", provider: "meta_social", display_name: "Instagram · @loja" }),
      canal({ id: "zs", provider: "zernio_social", display_name: "Facebook · Loja" }),
    ];
    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText("1 número conectado.")).toBeInTheDocument();
    expect(screen.queryByText("Instagram · @loja")).not.toBeInTheDocument();
    expect(screen.queryByText("Facebook · Loja")).not.toBeInTheDocument();
  });

  it("o critério é um só: ehCanalSocial", () => {
    expect(ehCanalSocial("meta_social")).toBe(true);
    expect(ehCanalSocial("zernio_social")).toBe(true);
    expect(ehCanalSocial("waha")).toBe(false);
    expect(ehCanalSocial("meta_cloud")).toBe(false);
    expect(ehCanalSocial(null)).toBe(false);
  });
});
