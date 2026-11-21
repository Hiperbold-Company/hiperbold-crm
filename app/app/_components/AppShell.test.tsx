/**
 * A CHAVE DO REDESIGN escolhe a moldura, e só a moldura.
 *
 * Desligada (o padrão de toda instalação), a casca desenha exatamente as peças
 * de sempre — `Sidebar`, `TopBar`, `BarraInferior` — e nada da moldura nova.
 * Ligada, desenha a moldura nova, e as portas dela saem da MESMA projeção do
 * catálogo (`sidebarGroups`, sem mock), com o mesmo papel: a régua de quem vê o
 * quê não pode ganhar uma segunda cópia.
 *
 * As peças antigas viram marcadores porque têm testes próprios (sidebar-*,
 * BarraInferior.celular, TenantSwitcher.celular); o que se prova aqui é qual
 * delas a casca monta. Viram dublê também as folhas que falam com a rede
 * (contadores, sinos, alertas, presença), cujo número tem teste próprio.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GRUPO_NO_RODAPE, sidebarGroups } from "@/lib/navigation/registry";
import type { Role } from "@/lib/auth/types";

const estado = { role: "admin" as Role, caminho: "/app/inbox" };

const usuario = {
  id: "u-1",
  email: "rosana@exemplo.com",
  full_name: "Rosana Silva",
  avatar_url: null,
  is_platform_admin: false,
  support: null,
  organizations: [{ organization_id: "org-1", organization_name: "Clínica Bem Estar", logo_url: null }],
};

vi.mock("@/hooks/auth/AuthProvider", () => {
  const org = () => ({
    orgId: "org-1",
    name: "Clínica Bem Estar",
    role: estado.role,
    interface_settings: undefined,
    modulos_ligados: [],
    capacidades_ligadas: [],
  });
  return {
    useAuth: () => ({ user: usuario, activeOrg: org(), signOut: vi.fn() }),
    useUser: () => usuario,
    useActiveOrg: () => org(),
    usePermission: () => true,
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => estado.caminho,
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/app/actions/shell/setActiveOrg", () => ({ setActiveOrg: vi.fn() }));
vi.mock("@/app/actions/settings/trocarIdioma", () => ({ trocarIdioma: vi.fn() }));
vi.mock("@/components/shell/OrganizationTransitionProvider", () => ({
  useOrganizationTransition: () => ({ begin: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));

// Hooks de rede da casca: chamados nas duas molduras, sem efeito aqui.
vi.mock("@/hooks/atendimento/useSinalDePresenca", () => ({ useSinalDePresenca: vi.fn() }));
vi.mock("@/hooks/notifications/useInboundMessageAlerts", () => ({ useInboundMessageAlerts: vi.fn() }));
vi.mock("@/hooks/calls/useInboundCallAlerts", () => ({ useInboundCallAlerts: vi.fn() }));
vi.mock("@/hooks/notifications/useCrmAlerts", () => ({ useCrmAlerts: vi.fn() }));
vi.mock("@/lib/notifications/notify_open", () => ({ useNotifyOpenFromServiceWorker: vi.fn() }));
vi.mock("@/lib/notifications/service_worker", () => ({ ensureNotifyServiceWorker: vi.fn() }));
vi.mock("@/components/shell/BarraDeProgressoNavegacao", () => ({ BarraDeProgressoNavegacao: () => null }));

// Folhas que leem React Query / rede.
vi.mock("@/components/shell/ContadorDaFila", () => ({
  ContadorDaFila: () => <span data-testid="contador-fila" />,
}));
vi.mock("@/components/shell/ContadorDeCasos", () => ({ ContadorDeCasos: () => null }));
vi.mock("@/components/shell/ContadorDeTarefas", () => ({ ContadorDeTarefas: () => null }));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({ ConnectionHealthDot: () => null }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));
vi.mock("@/components/shell/SearchTrigger", () => ({ SearchTrigger: () => <span data-testid="busca" /> }));
vi.mock("@/components/shell/SinoDeTarefas", () => ({ SinoDeTarefas: () => <span data-testid="sino-tarefas" /> }));
vi.mock("@/components/shell/AlertsBell", () => ({ AlertsBell: () => <span data-testid="sino-alertas" /> }));
vi.mock("@/components/shell/AvisoDePropostaEmDestaque", () => ({ AvisoDePropostaEmDestaque: () => null }));

// A moldura de sempre, como marcadores.
vi.mock("@/components/shell/Sidebar", () => ({ Sidebar: () => <div data-testid="moldura-antiga-sidebar" /> }));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => <div data-testid="moldura-antiga-topbar" /> }));
vi.mock("@/components/shell/BarraInferior", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  BarraInferior: () => <div data-testid="moldura-antiga-barra-inferior" />,
}));

import { ProvedorDaOcupacaoDoRodape } from "@/lib/ui/rodape-ocupado";
import { AppShell } from "./AppShell";

afterEach(cleanup);

function montar(redesign: boolean | undefined) {
  return render(
    <ProvedorDaOcupacaoDoRodape>
      <AppShell sidebarCollapsed={false} podeAtender ajudaBase={null} redesign={redesign}>
        <p>conteúdo</p>
      </AppShell>
    </ProvedorDaOcupacaoDoRodape>,
  );
}

describe("AppShell — chave do redesign", () => {
  it.each([undefined, false])("desligada (%s): a moldura de sempre, nada da nova", (redesign) => {
    const { container } = montar(redesign);
    expect(screen.getByTestId("moldura-antiga-sidebar")).toBeTruthy();
    expect(screen.getByTestId("moldura-antiga-topbar")).toBeTruthy();
    expect(screen.getByTestId("moldura-antiga-barra-inferior")).toBeTruthy();
    expect(container.querySelector("[data-moldura]")).toBeNull();
    expect(screen.getByText("conteúdo")).toBeTruthy();
  });

  it("ligada: a moldura nova, nenhuma peça da antiga, o mesmo conteúdo", () => {
    const { container } = montar(true);
    expect(screen.queryByTestId("moldura-antiga-sidebar")).toBeNull();
    expect(screen.queryByTestId("moldura-antiga-topbar")).toBeNull();
    expect(screen.queryByTestId("moldura-antiga-barra-inferior")).toBeNull();
    expect(container.querySelectorAll('[data-moldura="redesign"]').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("conteúdo")).toBeTruthy();
    // As ferramentas do topo de sempre continuam na moldura nova.
    expect(screen.getByTestId("busca")).toBeTruthy();
    expect(screen.getByTestId("sino-tarefas")).toBeTruthy();
    expect(screen.getByTestId("sino-alertas")).toBeTruthy();
    expect(screen.getByTestId("menu-do-usuario")).toBeTruthy();
  });

  it.each(["admin", "agent", "viewer"] as Role[])(
    "ligada, papel %s: o menu lateral tem exatamente as portas de sidebarGroups()",
    (papel) => {
      estado.role = papel;
      const { container } = montar(true);
      const menu = container.querySelector('aside[data-moldura="redesign"]') as HTMLElement;
      const nav = within(menu).getByRole("navigation", { name: "Navegação principal" });
      const hrefs = within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href"));
      const grupos = sidebarGroups(false, papel, undefined, [], []);
      const esperados = grupos.filter((g) => g.group.id !== GRUPO_NO_RODAPE).flatMap((g) => g.items.map((d) => d.href));
      expect(hrefs).toEqual(esperados);
      const rodape = grupos.find((g) => g.group.id === GRUPO_NO_RODAPE)?.group.hub;
      if (rodape) expect(within(menu).getByRole("link", { name: rodape.label }).getAttribute("href")).toBe(rodape.href);
      estado.role = "admin";
    },
  );

  it("ligada: o contador da fila acompanha a porta do Chat, como no menu de sempre", () => {
    const { container } = montar(true);
    const menu = container.querySelector('aside[data-moldura="redesign"]') as HTMLElement;
    const chat = within(menu)
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === "/app/inbox") as HTMLElement;
    expect(within(chat).getByTestId("contador-fila")).toBeTruthy();
  });

  it("ligada: a barra do celular usa a mesma régua de abas", async () => {
    const { PREFERIDAS, VAGAS } = await import("@/components/shell/BarraInferior");
    const { container } = montar(true);
    const barra = container.querySelector("[data-barra-inferior]") as HTMLElement;
    const visiveis = new Set(
      sidebarGroups(false, "admin", undefined, [], []).flatMap((g) => g.items.map((d) => d.href)),
    );
    const esperadas = PREFERIDAS.filter((h) => visiveis.has(h)).slice(0, VAGAS);
    const hrefs = within(barra)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(esperadas);
    expect(within(barra).getByRole("button", { name: "Mais" })).toBeTruthy();
  });

  it("ligada: um só `tenant-switcher` na tela — o da largura atual (desktop no jsdom)", () => {
    usuario.is_platform_admin = true;
    try {
      const { container } = montar(true);
      const todos = screen.getAllByTestId("tenant-switcher");
      expect(todos).toHaveLength(1);
      expect(container.querySelector('aside[data-moldura="redesign"]')?.contains(todos[0] as Node)).toBe(true);
    } finally {
      usuario.is_platform_admin = false;
    }
  });

  it("ligada: o menu do usuário abre com Idioma, e Idioma lista os idiomas visíveis", async () => {
    const { IDIOMAS_VISIVEIS } = await import("@/lib/i18n/registro");
    montar(true);
    const gatilho = screen.getByTestId("menu-do-usuario");
    fireEvent.pointerDown(gatilho, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const idioma = await screen.findByTestId("seletor-de-idioma");
    expect(idioma.textContent).toContain("Idioma");
    fireEvent.click(idioma);
    fireEvent.keyDown(idioma, { key: "ArrowRight" });
    for (const { codigo } of IDIOMAS_VISIVEIS) {
      expect(await screen.findByTestId(`idioma-${codigo}`)).toBeTruthy();
    }
    expect(screen.getByRole("menuitem", { name: /Sair/ })).toBeTruthy();
  });
});
