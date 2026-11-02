/**
 * O link "Dúvidas?" abaixo do título: aparece só com central configurada E
 * artigo próprio da tela; nunca aponta para a página genérica do produto.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let rotaAtual = "/app/contacts";
vi.mock("next/navigation", () => ({ usePathname: () => rotaAtual }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ProvedorDaCentralDeAjuda } from "@/lib/ajuda/contexto";
import { LinkDeAjudaDaTela } from "./LinkDeAjudaDaTela";

const BASE = "https://ajuda.exemplo.com";

function comCentral(ui: React.ReactNode, base: string | null = BASE) {
  return render(<ProvedorDaCentralDeAjuda base={base}>{ui}</ProvedorDaCentralDeAjuda>);
}

beforeEach(() => {
  rotaAtual = "/app/contacts";
});
afterEach(cleanup);

describe("LinkDeAjudaDaTela", () => {
  it("leva ao artigo da tela, em nova aba, sem entregar a janela de origem", () => {
    comCentral(<LinkDeAjudaDaTela />);
    const link = screen.getByRole("link", { name: /Veja como usar esta tela/ });
    expect(link).toHaveAttribute("href", `${BASE}/crm/funis-e-leads/contatos/`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.closest("p")?.textContent).toMatch(/^Dúvidas\? /);
  });

  it("sem central configurada não aparece", () => {
    const { container } = comCentral(<LinkDeAjudaDaTela />, null);
    expect(container).toBeEmptyDOMElement();
  });

  it("sem provedor (fora da casca do app) não aparece", () => {
    const { container } = render(<LinkDeAjudaDaTela />);
    expect(container).toBeEmptyDOMElement();
  });

  it("tela sem artigo próprio não aparece (não cai na página genérica)", () => {
    rotaAtual = "/app/settings";
    const { container } = comCentral(<LinkDeAjudaDaTela />);
    expect(container).toBeEmptyDOMElement();
  });

  it("caminho explícito vence a rota; null explícito esconde", () => {
    comCentral(
      <LinkDeAjudaDaTela
        caminho="/crm/receber-leads/leads-recebidos/"
        rotulo="Outro texto"
        semPrefixo
      />,
    );
    const link = screen.getByRole("link", { name: /Outro texto/ });
    expect(link).toHaveAttribute("href", `${BASE}/crm/receber-leads/leads-recebidos/`);
    expect(link.closest("p")?.textContent).not.toContain("Dúvidas?");
    cleanup();
    const { container } = comCentral(<LinkDeAjudaDaTela caminho={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
