/**
 * O SELETOR DE TIPO DE DOCUMENTO no cadastro do contato (EUA, 24/11/2026): aparece
 * quando o país da organização tem mais de um tipo, e o número segue a régua do
 * tipo escolhido. No Brasil a tela é a de sempre, sem seletor.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderRTL, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const orgAtiva = vi.hoisted(() => ({ atual: { currency: "BRL", country: null as string | null } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => orgAtiva.atual,
  useAuth: () => ({ activeOrg: null }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { NewContactDialog } from "@/components/contacts/NewContactDialog";

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderRTL(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function criarContato() {
  return screen.getByRole("button", { name: "Criar contato" });
}

afterEach(() => {
  cleanup();
  orgAtiva.atual = { currency: "BRL", country: null };
  vi.clearAllMocks();
});

describe("seletor de tipo de documento", () => {
  it("Brasil: não há seletor, o campo continua sendo o CPF", () => {
    render(<NewContactDialog open onOpenChange={() => {}} />);
    expect(screen.queryByLabelText("Tipo de documento")).toBeNull();
    expect(screen.getByLabelText(/CPF/i)).toBeTruthy();
  });

  it("EUA: o seletor aparece com os tipos válidos e sem SSN", () => {
    orgAtiva.atual = { currency: "USD", country: "US" };
    render(<NewContactDialog open onOpenChange={() => {}} />);
    const seletor = screen.getByLabelText("Tipo de documento") as HTMLSelectElement;
    const valores = Array.from(seletor.options).map((o) => o.value);
    expect(valores).toEqual([
      "",
      "us_drivers_license",
      "us_state_id",
      "us_passport",
      "us_green_card",
      "us_itin",
      "foreign_passport",
      "br_cpf",
    ]);
    expect(valores.some((v) => v.includes("ssn"))).toBe(false);
  });

  it("EUA: número sem tipo é barrado no campo; com o tipo, vai tipo + número no POST", async () => {
    orgAtiva.atual = { currency: "USD", country: "US" };
    const usuario = userEvent.setup();
    api.post.mockResolvedValue({ data: { contact: { id: "contato-teste" } } });
    render(<NewContactDialog open onOpenChange={() => {}} />);

    await usuario.type(screen.getByLabelText(/^Email$/), "contato@example.test");
    const numero = screen.getByLabelText(/Número do documento/);
    await usuario.type(numero, "A12345678");
    await usuario.tab();
    expect((await screen.findByRole("alert")).textContent).toBe("Escolha o tipo do documento");

    await usuario.selectOptions(screen.getByLabelText("Tipo de documento"), "us_passport");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await usuario.click(criarContato());

    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/contacts",
      expect.objectContaining({ cpf: "A12345678", document_type: "us_passport" }),
    );
  });
});
