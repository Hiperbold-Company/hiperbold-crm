/**
 * O formulário de agente exige uma chave e um número de WhatsApp. Desde 15/10/2026
 * Conexões e Credenciais não estão no menu lateral, então a própria tela tem de dizer
 * ONDE se consegue cada um — com ou sem credencial/número já cadastrados. Espelho do
 * caso `agente-novo-e-uso.spec.ts` ("a tela oferece caminho para o que ela exige").
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents/new",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";

function hrefsDaTela(opts: { credenciais: unknown[]; numeros: unknown[]; chaveDaInstalacao?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="create"
        credentials={opts.credenciais as never}
        channelSessions={opts.numeros as never}
        provedoresDaInstalacao={opts.chaveDaInstalacao ? ["anthropic"] : []}
      />
    </QueryClientProvider>,
  );
  return [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
}

const numero = {
  id: "11111111-1111-4111-8111-111111111111",
  display_name: "Atendimento",
  phone_number: null,
  status: "WORKING",
};
const credencial = {
  id: "22222222-2222-4222-8222-222222222222",
  provider: "anthropic",
  label: "Principal",
  api_key_last4: "abcd",
  validated_at: "2026-10-01T00:00:00Z",
  validation_error: null,
  is_active: true,
};

describe("AgentForm: caminho para o que a tela exige", () => {
  it("sem credencial nem número, aponta para Credenciais e Conexões", () => {
    const hrefs = hrefsDaTela({ credenciais: [], numeros: [] });
    expect(hrefs).toContain("/app/ai/credentials");
    expect(hrefs).toContain("/app/connections");
  });

  it("com credencial e número já cadastrados, os dois caminhos continuam na tela", () => {
    const hrefs = hrefsDaTela({ credenciais: [credencial], numeros: [numero] });
    expect(hrefs).toContain("/app/ai/credentials");
    expect(hrefs).toContain("/app/connections");
  });

  it("com a chave da instalação (cliente da plataforma), não empurra cadastro de chave mas mantém o caminho discreto", () => {
    const hrefs = hrefsDaTela({ credenciais: [], numeros: [numero], chaveDaInstalacao: true });
    expect(hrefs).toContain("/app/connections");
    // Não é o convite "Cadastrar credencial ..." de quem não tem opção nenhuma.
    expect(document.body.textContent).not.toMatch(/Cadastrar credencial/);
  });
});
