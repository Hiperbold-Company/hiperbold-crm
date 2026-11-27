/**
 * MENU POR ÁREAS DO V49 — o casco novo.
 *
 * O menu lista as áreas (Conversas, não Chat/Radar), a faixa de abas segue a
 * área da tela (Contatos tem Campanhas, não Etapas do funil) e a IA ganha a
 * coluna lateral Montar / Ensinar / Acompanhar.
 *
 * O que não é o objeto do teste (contadores, busca, cartão da empresa, ação de
 * recolher) é dublado; a navegação e o catálogo são os de verdade.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ pathname: "/app/inbox" }));

vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { is_platform_admin: false, support: null },
    activeOrg: {
      role: "admin",
      interface_settings: undefined,
      modulos_ligados: [],
      capacidades_ligadas: [],
    },
  }),
  useUser: () => ({ is_platform_admin: false, support: null }),
  usePermission: () => true,
}));
vi.mock("@/hooks/navigation/prefetchPorIntencao", () => ({ usePrefetchPorIntencao: () => () => ({}) }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({ ConnectionHealthDot: () => null }));
vi.mock("@/components/shell/ContadorDaFila", () => ({ ContadorDaFila: () => null }));
vi.mock("@/components/shell/ContadorDeCasos", () => ({ ContadorDeCasos: () => null }));
vi.mock("@/components/shell/ContadorDeTarefas", () => ({ ContadorDeTarefas: () => null }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));
vi.mock("@/components/shell/AlertsBell", () => ({ AlertsBell: () => null }));
vi.mock("@/components/shell/AvisoDePropostaEmDestaque", () => ({ AvisoDePropostaEmDestaque: () => null }));
vi.mock("@/components/shell/BotaoAjuda", () => ({ BotaoAjuda: () => null }));
vi.mock("@/components/shell/SearchTrigger", () => ({ SearchTrigger: () => null }));
vi.mock("@/components/shell/SinoDeTarefas", () => ({ SinoDeTarefas: () => null }));
vi.mock("@/components/shell/redesign/MarcaECartaoDaEmpresa", () => ({
  CartaoDaEmpresa: () => null,
  MarcaDoMenu: () => null,
}));
vi.mock("@/components/shell/redesign/MenuDoUsuarioNovo", () => ({ MenuDoUsuarioNovo: () => null }));
vi.mock("@/components/shell/redesign/TodasAsSecoes", () => ({ TodasAsSecoes: () => null }));

import { BarraDaArea } from "@/components/shell/redesign/BarraDaArea";
import { ColunaDaIA } from "@/components/shell/redesign/ColunaDaIA";
import { MenuLateral } from "@/components/shell/redesign/MenuLateral";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

function Casco(): ReactNode {
  return (
    <ProvedorDoRedesign ligado>
      <MenuLateral collapsed={false} />
      <BarraDaArea />
      <ColunaDaIA />
    </ProvedorDoRedesign>
  );
}

function monta(pathname: string) {
  h.pathname = pathname;
  render(<Casco />);
  return {
    menu: screen.getByRole("navigation", { name: "Navegação principal" }),
    faixa: screen.getByRole("navigation", { name: "Seções da área" }),
  };
}

afterEach(cleanup);

describe("menu por áreas do v49", () => {
  it("o menu mostra Conversas e não Chat nem Radar como itens", () => {
    const { menu } = monta("/app/inbox");
    expect(within(menu).getByRole("link", { name: /Conversas/ })).toBeTruthy();
    expect(within(menu).queryByRole("link", { name: /^Chat/ })).toBeNull();
    expect(within(menu).queryByRole("link", { name: /Radar/ })).toBeNull();
    expect(within(menu).getByRole("link", { name: /Conversas/ }).getAttribute("aria-current")).toBe("page");
  });

  it("em /app/contacts a faixa tem Campanhas e não Etapas do funil", () => {
    const { faixa } = monta("/app/contacts");
    expect(within(faixa).getByRole("link", { name: "Campanhas" })).toBeTruthy();
    expect(within(faixa).queryByRole("link", { name: "Etapas do funil" })).toBeNull();
  });

  it("em /app/ai/memory a coluna da IA mostra Ensinar e Memória acesa; a faixa não aparece", () => {
    monta("/app/ai/memory");
    const coluna = screen.getByRole("navigation", { name: "Seções da IA" });
    expect(within(coluna).getByText("Ensinar")).toBeTruthy();
    expect(within(coluna).getByText("Montar")).toBeTruthy();
    expect(within(coluna).getByText("Acompanhar")).toBeTruthy();
    const memoria = within(coluna).getByRole("link", { name: "Memória" });
    expect(memoria.getAttribute("aria-current")).toBe("page");
    expect(within(screen.getByRole("navigation", { name: "Seções da área" })).queryAllByRole("link")).toEqual([]);
  });

  it("fora da IA não há coluna da IA", () => {
    monta("/app/contacts");
    expect(screen.queryByRole("navigation", { name: "Seções da IA" })).toBeNull();
  });

  it("em /app/team a coluna de Configurações mostra Você/Empresa/Integrações, Equipe acesa, a trilha e nenhuma aba na faixa", () => {
    const { faixa } = monta("/app/team");
    const coluna = screen.getByRole("navigation", { name: "Seções das Configurações" });
    for (const g of ["Você", "Empresa", "Integrações"]) expect(within(coluna).getByText(g)).toBeTruthy();
    expect(within(coluna).getByRole("link", { name: "Equipe" }).getAttribute("aria-current")).toBe("page");
    expect(within(coluna).getByRole("link", { name: "Configurações" }).getAttribute("href")).toBe("/app/settings");
    // Tipos de agendamento é aba da Agenda: não entra na coluna.
    expect(within(coluna).queryByRole("link", { name: "Tipos de agendamento" })).toBeNull();
    expect(within(faixa).queryAllByRole("link")).toEqual([]);
    expect(screen.getByText("Configurações", { selector: "p > span" }).parentElement?.textContent).toBe("Configurações›Empresa");
  });

  it("em /app/settings/tenant/agenda (aba da Agenda) não há coluna de Configurações e a faixa é a da Agenda", () => {
    const { faixa } = monta("/app/settings/tenant/agenda");
    expect(screen.queryByRole("navigation", { name: "Seções das Configurações" })).toBeNull();
    expect(within(faixa).getByRole("link", { name: "Tipos de agendamento" })).toBeTruthy();
  });
});
