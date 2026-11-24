/**
 * A dica da importação nos EUA cita as colunas do documento e do TIPO, o +1 e o
 * aviso de SSN. No Brasil (e em Portugal) a frase é a de sempre.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderRTL, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const orgAtiva = vi.hoisted(() => ({ atual: { country: null as string | null } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => orgAtiva.atual,
  useAuth: () => ({ activeOrg: null }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ImportContactsDialog } from "@/components/contacts/ImportContactsDialog";

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderRTL(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  orgAtiva.atual = { country: null };
});

describe("dica da importação por país", () => {
  it("nos EUA cita document_type, o +1 e o SSN", () => {
    orgAtiva.atual = { country: "US" };
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    const dica = screen.getByText(/colunas reconhecidas/);
    expect(dica.textContent).toContain("document_type");
    expect(dica.textContent).toContain("+1");
    expect(dica.textContent).toContain("Não envie SSN");
    expect(dica.textContent).not.toMatch(/\bcpf\b/);
  });

  it("no Brasil segue a frase de sempre, com cpf e sem coluna de tipo", () => {
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    const dica = screen.getByText(/colunas reconhecidas/);
    expect(dica.textContent).toContain("cpf");
    expect(dica.textContent).not.toContain("document_type");
  });
});
