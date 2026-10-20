import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import type { Lead } from "@/lib/types/leads";

/**
 * OS PRODUTOS NA FICHA DO NEGÓCIO (migration 0972).
 *
 * Duas promessas que a tela precisa cumprir, e que o banco só garante se a tela
 * não brigar com ele:
 *  - com produtos, o Valor é a SOMA deles: o campo vira leitura e o "Salvar" não
 *    envia `value_cents` (o banco o mantém);
 *  - sem produtos, o Valor continua o que a pessoa digita e vai no "Salvar".
 * E a regra do produto de valor variável: o valor unitário é obrigatório.
 */
const mutateAsync = vi.fn(async () => ({}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/contacts/useEtiquetasParaEscolher", () => ({
  useEtiquetasParaEscolher: () => ({ data: [], isLoading: false, isError: false }),
}));

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const FIXO = {
  id: "p-fixo", codigo: "CONS", nome: "Consulta", ativo: true,
  tipo_de_preco: "fixo", preco_cents: 15000, moeda: "BRL",
};
const VARIAVEL = {
  id: "p-var", codigo: "PROJ", nome: "Projeto sob medida", ativo: true,
  tipo_de_preco: "variavel", preco_cents: null, moeda: "BRL",
};

const item = (id: string, nome: string, quantidade: number, valor: number) => ({
  id, lead_id: LEAD_ID, product_id: null, nome_snapshot: nome, quantidade,
  valor_unitario_cents: valor, created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z",
});

function lead(valueCents: number | null): Lead {
  return {
    id: LEAD_ID, organization_id: "org-1", title: "Maria", description: null,
    value_cents: valueCents, currency: "BRL", tags: [], expected_close_date: null, custom_fields: {},
  } as unknown as Lead;
}

function monta(itens: unknown[], valueCents: number | null) {
  get.mockImplementation(async (url: string) => {
    if (url === `/api/v1/leads/${LEAD_ID}/itens`) return { data: itens };
    if (url === "/api/v1/products") return { data: [FIXO, VARIAVEL] };
    throw new Error(`rota inesperada: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LeadFieldsForm lead={lead(valueCents)} pipelineId="p" />
    </QueryClientProvider>,
  );
}

const espera = { timeout: 5000 };
const salvar = () => userEvent.click(screen.getByRole("button", { name: /^Salvar$/ }));
const valorCampo = () => screen.getByLabelText("Valor (R$)") as HTMLInputElement;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ficha do negócio — produtos e valor", () => {
  it("com produtos, o Valor é a soma deles, em leitura, e o Salvar NÃO envia value_cents", async () => {
    // 2 × R$ 150,00 + 1 × R$ 4.800,00 = R$ 5.100,00
    monta([item("i1", "Consulta", 2, 15000), item("i2", "Projeto sob medida", 1, 480000)], 510000);

    await screen.findByTestId("itens-lista", undefined, espera);
    await waitFor(() => expect(valorCampo().value).toBe("5100,00"));
    expect(valorCampo().readOnly).toBe(true);
    expect(screen.getByTestId("valor-pela-soma")).toBeTruthy();
    expect(screen.getAllByTestId("item-subtotal")).toHaveLength(2);

    await salvar();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const patch = (mutateAsync.mock.calls[0] as unknown as [{ patch: Record<string, unknown> }])[0].patch;
    expect(patch).not.toHaveProperty("value_cents");
  });

  it("sem produtos, o Valor continua o que a pessoa digita e vai no Salvar", async () => {
    monta([], null);

    await screen.findByTestId("itens-vazio", undefined, espera);
    expect(valorCampo().readOnly).toBe(false);
    await userEvent.type(valorCampo(), "250,50");

    await salvar();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const patch = (mutateAsync.mock.calls[0] as unknown as [{ patch: Record<string, unknown> }])[0].patch;
    expect(patch).toMatchObject({ value_cents: 25050 });
  });

  it("produto de valor FIXO entra com o preço do catálogo preenchido e editável", async () => {
    monta([], null);
    await screen.findByRole("option", { name: /Consulta/ }, espera);
    await userEvent.selectOptions(screen.getByTestId("itens-seletor"), "p-fixo");

    const campo = screen.getByTestId("itens-novo-valor") as HTMLInputElement;
    expect(campo.value).toBe("150,00");

    await userEvent.clear(campo);
    await userEvent.type(campo, "120,00");
    await userEvent.click(screen.getByTestId("itens-adicionar-botao"));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/itens`, {
      product_id: "p-fixo",
      quantidade: 1,
      valor_unitario_cents: 12000,
    });
  });

  it("produto de valor VARIÁVEL nasce com o valor vazio e só adiciona depois de digitado", async () => {
    monta([], null);
    await screen.findByRole("option", { name: /Projeto sob medida/ }, espera);
    await userEvent.selectOptions(screen.getByTestId("itens-seletor"), "p-var");

    const campo = screen.getByTestId("itens-novo-valor") as HTMLInputElement;
    const botao = screen.getByTestId("itens-adicionar-botao") as HTMLButtonElement;
    expect(campo.value).toBe("");
    expect(botao.disabled).toBe(true);

    await userEvent.type(campo, "4800,00");
    expect(botao.disabled).toBe(false);
    await userEvent.click(botao);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/itens`, {
      product_id: "p-var",
      quantidade: 1,
      valor_unitario_cents: 480000,
    });
  });
});
