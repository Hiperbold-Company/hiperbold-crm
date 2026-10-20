/**
 * A tela "Chaves de acesso à IA" mostra, no topo, o cartão FIXO da chave do plano (a da instalação,
 * OpenRouter): sem Modelos, sem "Em uso por", sem editar/atualizar/excluir e sem dígitos. As chaves
 * que a empresa cadastrou continuam com tudo, e a OpenRouter dela se chama "OpenRouter (sua chave)".
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { CredentialRow } from "@/hooks/ai/useCredentials";
import { CredentialsList } from "./CredentialsList";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

function credencial(extra: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "c1",
    organization_id: "o1",
    provider: "openai",
    label: "Minha OpenAI",
    api_key_last4: "9f3k",
    validated_at: "2026-09-02T00:00:00Z",
    validation_error: null,
    models_available: null,
    is_active: true,
    created_by: null,
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    ...extra,
  };
}

function montar(credenciais: CredentialRow[], chaveDoPlano: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CredentialsList initialData={credenciais} canWrite usageMap={{}} chaveDoPlano={chaveDoPlano} />
    </QueryClientProvider>,
  );
}

describe("cartão fixo da chave do plano", () => {
  it("aparece no topo, com o selo e o texto do desconto, e SEM nenhuma ação nem dígito de chave", () => {
    montar([credencial()], true);

    const cartao = screen.getByTestId("chave-do-plano");
    expect(within(cartao).getByText("Chave própria do Hiperbold CRM (OpenRouter)")).toBeInTheDocument();
    expect(within(cartao).getByText("Incluída no seu plano")).toBeInTheDocument();
    expect(within(cartao).getByText("O uso desconta do limite de tokens do seu plano.")).toBeInTheDocument();
    // Nada de editar, atualizar, excluir, modelos, "em uso por" nem final da chave.
    expect(within(cartao).queryAllByRole("button")).toHaveLength(0);
    expect(within(cartao).queryByText(/Modelos|Em uso por|…/)).not.toBeInTheDocument();
    expect(cartao.textContent).not.toMatch(/…\w{4}/);
  });

  it("fica ACIMA das chaves da empresa", () => {
    montar([credencial()], true);
    const plano = screen.getByTestId("chave-do-plano");
    const propria = screen.getByText("Minha OpenAI");
    expect(plano.compareDocumentPosition(propria) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("só aparece quando o servidor tem a chave (OPENROUTER_API_KEY)", () => {
    montar([credencial()], false);
    expect(screen.queryByTestId("chave-do-plano")).not.toBeInTheDocument();
  });

  it("sem chave própria cadastrada, a tela diz que não é preciso cadastrar nada", () => {
    montar([], true);
    expect(screen.getByTestId("chave-do-plano")).toBeInTheDocument();
    expect(screen.getByText(/Você não precisa cadastrar nada/)).toBeInTheDocument();
  });
});

describe("chaves cadastradas pela empresa", () => {
  it("mantêm as ações de editar, atualizar e excluir e o final da chave", () => {
    montar([credencial()], true);
    expect(screen.getByRole("button", { name: "Editar credencial" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Excluir credencial" })).toBeInTheDocument();
    expect(screen.getByText("…9f3k")).toBeInTheDocument();
  });

  it("a OpenRouter da empresa se chama 'OpenRouter (sua chave)' e não se confunde com a do plano", () => {
    montar([credencial({ id: "c2", provider: "openrouter", label: "Minha OpenRouter" })], true);
    expect(screen.getByRole("heading", { name: "OpenRouter (sua chave)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chave própria do Hiperbold CRM (OpenRouter)" })).toBeInTheDocument();
  });
});
