/**
 * O CAMPO "EMPRESA DE INTELIGÊNCIA ARTIFICIAL" DO FORMULÁRIO DO AGENTE (20/10/2026).
 *
 * Lista só a chave do plano e os provedores que a empresa conectou; o agente antigo salvo num par que
 * o plano não permite mostra o valor atual com o aviso e fica sem salvar/publicar.
 */
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents/x",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";

function credencial(over: Record<string, unknown>) {
  return {
    id: "c1",
    organization_id: "o1",
    provider: "openai",
    label: "Minha OpenAI",
    api_key_last4: "abcd",
    validated_at: "2026-09-02T00:00:00Z",
    validation_error: null,
    models_available: null,
    is_active: true,
    created_by: null,
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    ...over,
  };
}

function renderizar(props: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const todas: Record<string, unknown> = { channelSessions: [], provedoresDaInstalacao: ["openrouter"], ...props };
  return render(
    <QueryClientProvider client={qc}>
      <AgentForm {...(todas as unknown as ComponentProps<typeof AgentForm>)} />
    </QueryClientProvider>,
  );
}

const versaoAntiga = {
  id: "v1",
  version_number: 1,
  status: "draft",
  system_prompt: "Você é um atendente educado.",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  credential_id: null,
  channel_session_id: null,
  tool_ids: [],
};

const agente = {
  id: "a1",
  organization_id: "o1",
  name: "Salomão",
  description: null,
  model: "anthropic/claude-sonnet-4-6",
  system_prompt: "x",
  is_active: true,
  is_default: false,
  kind: "mcp_agent",
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("campo Empresa de inteligência artificial", () => {
  it("agente novo, sem chave própria: abre na chave do plano, com a ajuda do desconto no limite", () => {
    renderizar({ mode: "create", credentials: [] });

    expect(screen.getByRole("combobox", { name: /Empresa de inteligência artificial/ })).toHaveTextContent(
      "Chave própria do Hiperbold CRM (OpenRouter)",
    );
    expect(screen.getByText("Na chave do Hiperbold CRM, o uso desconta do limite do seu plano.")).toBeInTheDocument();
    // Sem aviso de par não permitido.
    expect(screen.queryByText(/não disponível no seu plano/)).not.toBeInTheDocument();
    // Na chave do plano não há seletor de chave para escolher.
    expect(screen.queryByLabelText("Chave de acesso")).not.toBeInTheDocument();
  });

  it("agente antigo em Anthropic na chave da instalação: mostra o valor atual com o aviso, em vez de um campo em branco", () => {
    renderizar({
      mode: "edit",
      agent: agente,
      draft: versaoAntiga,
      published: null,
      base: versaoAntiga,
      credentials: [],
    });

    expect(screen.getByRole("combobox", { name: /Empresa de inteligência artificial/ })).toHaveTextContent(
      /Anthropic.*não disponível no seu plano; escolha outro/,
    );
    expect(screen.getAllByText(/não disponível no seu plano; escolha outro/).length).toBeGreaterThan(0);
    // Salvar e publicar ficam travados enquanto o par não for trocado.
    expect(screen.getByRole("button", { name: /Salvar/ })).toBeDisabled();
  });

  it("agente com a OpenAI conectada pela empresa: o campo mostra OpenAI e o seletor da chave dela", () => {
    renderizar({
      mode: "edit",
      agent: agente,
      draft: { ...versaoAntiga, provider: "openai", model: "gpt-6-luna", credential_id: "c1" },
      published: null,
      base: { ...versaoAntiga, provider: "openai", model: "gpt-6-luna", credential_id: "c1" },
      credentials: [credencial({})],
    });

    expect(screen.getByRole("combobox", { name: /Empresa de inteligência artificial/ })).toHaveTextContent(/OpenAI/);
    expect(screen.queryByText(/não disponível no seu plano/)).not.toBeInTheDocument();
    expect(screen.getByText("Chave de acesso")).toBeInTheDocument();
  });
});
