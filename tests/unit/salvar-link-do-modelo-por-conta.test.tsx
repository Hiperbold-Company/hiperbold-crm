/**
 * O link de mídia salvo no modelo vai para a conta oficial escolhida: com o id da conexão, o PATCH
 * leva `?channel_session_id=` (a rota grava só naquela WABA); sem ele, a rota de sempre.
 * Medir: pnpm vitest run tests/unit/salvar-link-do-modelo-por-conta.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { patch: h.patch } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { useSaveTemplateValues } from "@/hooks/channels/useTemplates";

const CONTA = "11111111-1111-4111-8111-111111111111";
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);
const ARGS = { name: "boas_vindas", language: "pt_BR", values: { "header:1": "https://x.test/a.png" } };

beforeEach(() => {
  h.patch.mockReset();
  h.patch.mockResolvedValue({ data: { savedValues: {} } });
});

describe("useSaveTemplateValues", () => {
  it("com o id da conexão, manda channel_session_id", async () => {
    const { result } = renderHook(() => useSaveTemplateValues(CONTA), { wrapper });
    await act(() => result.current.mutateAsync(ARGS));
    expect(h.patch).toHaveBeenCalledWith(`/api/v1/channels/templates?channel_session_id=${CONTA}`, ARGS);
  });

  it("sem id, a rota de sempre", async () => {
    const { result } = renderHook(() => useSaveTemplateValues(), { wrapper });
    await act(() => result.current.mutateAsync(ARGS));
    expect(h.patch).toHaveBeenCalledWith("/api/v1/channels/templates", ARGS);
  });
});
