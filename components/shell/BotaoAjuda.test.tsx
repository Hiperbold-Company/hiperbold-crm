/**
 * O botão "Ajuda" do topo: aparece só quando a instalação configurou a central
 * (`HELP_CENTER_URL`), abre em nova aba e leva ao artigo da tela atual.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let rotaAtual = "/app/contacts";
vi.mock("next/navigation", () => ({ usePathname: () => rotaAtual }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { BotaoAjuda } from "./BotaoAjuda";

beforeEach(() => {
  rotaAtual = "/app/contacts";
});

describe("botão Ajuda", () => {
  it("não aparece sem a central configurada", () => {
    const { container } = render(<BotaoAjuda base={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("link", { name: "Ajuda" })).toBeNull();
  });

  it("abre o artigo da tela atual, em nova aba, sem entregar a janela de origem", () => {
    render(<BotaoAjuda base="https://ajuda.exemplo.com" />);
    const link = screen.getByRole("link", { name: "Ajuda" });
    expect(link).toHaveAttribute("href", "https://ajuda.exemplo.com/crm/funis-e-leads/contatos/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("segue a tela: outra rota, outro artigo", () => {
    rotaAtual = "/app/team/invite";
    render(<BotaoAjuda base="https://ajuda.exemplo.com" />);
    expect(screen.getByRole("link", { name: "Ajuda" })).toHaveAttribute(
      "href",
      "https://ajuda.exemplo.com/crm/equipe/convidar-pessoas/",
    );
  });

  it("tela sem artigo vai para a página do produto", () => {
    rotaAtual = "/app/tela-sem-artigo";
    render(<BotaoAjuda base="https://ajuda.exemplo.com" />);
    expect(screen.getByRole("link", { name: "Ajuda" })).toHaveAttribute(
      "href",
      "https://ajuda.exemplo.com/crm/",
    );
  });
});
