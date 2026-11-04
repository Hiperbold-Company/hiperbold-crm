/**
 * A central de ajuda dentro do CRM: o item da barra lateral (logo acima de
 * Configurações, só com `HELP_CENTER_URL`) e o link de cada aba de
 * Automações e webhooks.
 *
 * O endereço chega pelo provedor que o `AppShell` monta com o valor lido no
 * servidor; sem ele, nada aparece, porque o produto é white-label.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sidebar } from "@/components/shell/Sidebar";
import { ProvedorDaCentralDeAjuda } from "@/lib/ajuda/contexto";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: { orgId: "org-1", name: "Org", role: "admin" },
};

let rotaAtual = "/app/inbox";
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => authRef,
  usePermission: () => false,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => rotaAtual,
  useSearchParams: () => new URLSearchParams(),
  // A barra lateral do upstream pré-carrega o destino por intenção (`usePrefetchPorIntencao`).
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
// Os contadores da barra lateral do upstream (casos, fila e tarefas) consultam o servidor; aqui ficam fora.
vi.mock("@/components/shell/ContadorDeCasos", () => ({ ContadorDeCasos: () => null }));
vi.mock("@/components/shell/ContadorDaFila", () => ({ ContadorDaFila: () => null }));
vi.mock("@/components/shell/ContadorDeTarefas", () => ({ ContadorDeTarefas: () => null }));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));
// As abas buscam dados ao montar; o que se mede aqui é o topo de cada uma.
vi.mock("@/app/app/webhooks/_components/RulesTab", () => ({ RulesTab: () => <div>regras</div> }));
vi.mock("@/app/app/webhooks/_components/SourcesTab", () => ({
  SourcesTab: () => <div>fontes</div>,
}));
vi.mock("@/app/app/webhooks/_components/CapturasTab", () => ({
  CapturasTab: () => <div>capturas</div>,
}));
vi.mock("@/app/app/webhooks/_components/ActivityTab", () => ({
  ActivityTab: () => <div>atividade</div>,
}));

import { WebhooksClient } from "@/app/app/webhooks/_components/WebhooksClient";

const BASE = "https://ajuda.exemplo.com";

afterEach(() => {
  cleanup();
  rotaAtual = "/app/inbox";
});

describe("Central de ajuda na barra lateral", () => {
  it("fica logo acima de Configurações e abre a página do CRM em nova aba", () => {
    render(
      <ProvedorDaCentralDeAjuda base={BASE}>
        <Sidebar collapsed={false} />
      </ProvedorDaCentralDeAjuda>,
    );
    const ajuda = screen.getByRole("link", { name: /Central de ajuda/ });
    expect(ajuda).toHaveAttribute("href", `${BASE}/crm/`);
    expect(ajuda).toHaveAttribute("target", "_blank");
    expect(ajuda.getAttribute("rel")).toContain("noopener");
    expect(ajuda.textContent).toContain("(abre em nova aba)");

    const config = screen.getByRole("link", { name: /Configurações/ });
    expect(ajuda.parentElement).toBe(config.parentElement);
    expect(ajuda.nextElementSibling).toBe(config);
    // Fora da navegação que rola, como Configurações.
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    expect(within(nav).queryByRole("link", { name: /Central de ajuda/ })).toBeNull();
  });

  it("recolhida, continua com nome acessível e dica", () => {
    render(
      <ProvedorDaCentralDeAjuda base={BASE}>
        <Sidebar collapsed />
      </ProvedorDaCentralDeAjuda>,
    );
    const ajuda = screen.getByRole("link", { name: "Central de ajuda (abre em nova aba)" });
    expect(ajuda).toHaveAttribute("title", "Central de ajuda");
  });

  it("sem HELP_CENTER_URL não aparece", () => {
    render(
      <ProvedorDaCentralDeAjuda base={null}>
        <Sidebar collapsed={false} />
      </ProvedorDaCentralDeAjuda>,
    );
    expect(screen.queryByRole("link", { name: /Central de ajuda/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Configurações/ })).toBeInTheDocument();
  });
});

describe("Automações e webhooks: o artigo de cada aba", () => {
  function abrir() {
    rotaAtual = "/app/webhooks";
    return render(
      <ProvedorDaCentralDeAjuda base={BASE}>
        <WebhooksClient />
      </ProvedorDaCentralDeAjuda>,
    );
  }

  function linksDoPainel() {
    const painel = screen.getByRole("tabpanel");
    return within(painel)
      .queryAllByRole("link")
      .map((a) => a.getAttribute("href"));
  }

  it("Automações (aba inicial) leva às regras de automação", () => {
    abrir();
    expect(linksDoPainel()).toEqual([`${BASE}/crm/automacoes/regras-em-automacoes-e-webhooks/`]);
  });

  it("Receber dados leva às fontes e a como conectar o formulário", async () => {
    abrir();
    await userEvent.click(screen.getByRole("tab", { name: "Receber dados" }));
    expect(linksDoPainel()).toEqual([
      `${BASE}/crm/receber-leads/fontes-de-captacao/`,
      `${BASE}/crm/receber-leads/conectar-formularios-e-n8n/`,
    ]);
    expect(
      screen.getByRole("link", { name: /Como conectar o formulário do seu site/ }),
    ).toBeInTheDocument();
  });

  it("Leads recebidos leva ao seu artigo; Atividade não tem link", async () => {
    abrir();
    await userEvent.click(screen.getByRole("tab", { name: "Leads recebidos" }));
    expect(linksDoPainel()).toEqual([`${BASE}/crm/receber-leads/leads-recebidos/`]);
    await userEvent.click(screen.getByRole("tab", { name: "Registro de atividade" }));
    expect(linksDoPainel()).toEqual([]);
  });

  it("as quatro abas continuam as mesmas, na mesma ordem", () => {
    abrir();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Automações",
      "Receber dados",
      "Leads recebidos",
      "Registro de atividade",
    ]);
  });
});
