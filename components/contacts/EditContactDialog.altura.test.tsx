/**
 * O DIÁLOGO "EDITAR CONTATO" CABE NA TELA.
 *
 * O `DialogContent` base é um `grid` sem altura máxima: com campos
 * personalizados o formulário passava da viewport e o usuário não alcançava
 * Salvar/Cancelar (CBEXS, 28/10/2026). jsdom não tem layout, então o que se
 * prova aqui é a ESTRUTURA que o layout exige: altura presa à viewport no
 * conteúdo, corpo que rola por dentro e rodapé FORA do trecho que rola. A
 * medida em pixels (1366x768 e 375x812) foi feita no Chromium com o markup
 * deste mesmo componente.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import type { Contact } from "@/lib/types/contacts";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const CONTATO = {
  id: "ct-1",
  organization_id: "org-1",
  name: "Joana Prado",
  email: "joana@example.com",
  phone_number: null,
  birthdate: null,
  tags: [],
  custom_fields: {},
} as unknown as Contact;

const CAMPOS = Array.from({ length: 12 }, (_, i) => ({
  key: `campo_${i}`,
  label: `Campo ${i}`,
  type: "text",
})) as never;

function abrir() {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <EditContactDialog contact={CONTATO} open onOpenChange={() => {}} customFieldDefs={CAMPOS} />
    </QueryClientProvider>,
  );
}

describe("EditContactDialog: altura", () => {
  it("prende a altura do diálogo à viewport", () => {
    abrir();
    const dialogo = screen.getByTestId("editar-contato-dialog");
    expect(dialogo.className).toMatch(/max-h-\[90d?vh\]/);
    expect(dialogo.className).toContain("flex-col");
  });

  it("só o corpo rola; Salvar e Cancelar ficam fora do trecho que rola", () => {
    abrir();
    const corpo = screen.getByTestId("editar-contato-corpo");
    expect(corpo.className).toContain("overflow-y-auto");
    expect(corpo.className).toContain("min-h-0");

    const salvar = screen.getByRole("button", { name: "Salvar" });
    const cancelar = screen.getByRole("button", { name: "Cancelar" });
    expect(corpo.contains(salvar)).toBe(false);
    expect(corpo.contains(cancelar)).toBe(false);
    // O título também fica fora do corpo.
    expect(corpo.contains(screen.getByText("Editar contato"))).toBe(false);
    // Os campos estão dentro dele.
    expect(corpo.contains(screen.getByLabelText("Nome"))).toBe(true);
  });
});
