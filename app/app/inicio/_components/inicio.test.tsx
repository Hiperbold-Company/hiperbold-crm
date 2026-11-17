/**
 * O Início nos dois estados e o que o painel entrega.
 *
 * Medimos o comportamento que a pessoa vê: com obrigatório faltando é só o checklist (como sempre
 * foi); com os obrigatórios cumpridos aparecem o painel, a barra lateral e o botão que a recolhe, e
 * a escolha fica lembrada por pessoa. A rede é o único dublê (`apiClient`): hooks, componentes e a
 * conta das origens são os de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inicio",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({ id: "user-1", idioma: "pt-BR", is_platform_admin: false, support: false })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "org-1", role: "admin" })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/inicio/carregar", () => ({ carregarPrimeirosPassos: vi.fn() }));

import { apiClient } from "@/lib/api/client";
import { carregarPrimeirosPassos } from "@/lib/inicio/carregar";
import { primeirosPassos, type DadosDosPrimeirosPassos } from "@/lib/inicio/primeiros-passos";

import InicioPage from "../page";
import { hrefDaDesempenho } from "./PainelDoInicio";

// Polyfills que o Radix Select e os gráficos exigem e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const BASE: DadosDosPrimeirosPassos = {
  compraLigada: false,
  planoAtivo: false,
  emailVerificado: false,
  oQueFaz: "Vendemos móveis",
  fuso: "America/Sao_Paulo",
  whatsappConectado: true,
  agentePublicado: false,
  marcaPorOrganizacaoLigada: false,
  logoDefinido: false,
  followupAtivo: false,
  membrosAtivos: 1,
};

const ATENDIMENTO = {
  janela: { from: "2026-10-18T00:00:00Z", to: "2026-11-17T00:00:00Z" },
  fuso: "America/Sao_Paulo",
  cartoes: { atendimentos: 42, atendimentos_anterior: 30, finalizados: 30, em_aberto: 12, aguardando: 5 },
  tempos: { primeira_resposta_seg: 90, resposta_seg: 120, respostas: 77 },
  diario: [],
  mapa_de_calor: [],
  atendentes: [],
};
const NEGOCIOS = {
  janela: { from: "", to: "" },
  moeda: "BRL",
  fuso: "America/Sao_Paulo",
  fora_da_moeda: 0,
  cartoes: {
    criados: { quantidade: 11, valor_cents: 100000 },
    ganhos: { quantidade: 4, valor_cents: 50000 },
    perdidos: { quantidade: 2, valor_cents: 20000 },
    em_aberto: { quantidade: 5, valor_cents: 30000 },
    carteira: { quantidade: 9, valor_cents: 90000 },
  },
  diario: [],
  etapas: [],
  funis: [],
  movimentacoes: { total: 0, por_etapa: [] },
  atendentes: [],
};
const ORIGENS = {
  janela: { from: "", to: "" },
  moeda: "BRL",
  total: 35,
  limite: 50,
  por_source: [
    { chave: "google", total: 10, ganhos: 3, perdidos: 1, abertos: 6, valor_ganho_cents: 0, taxa_de_ganho: 0.3 },
    { chave: null, total: 25, ganhos: 8, perdidos: 2, abertos: 15, valor_ganho_cents: 0, taxa_de_ganho: 0.32 },
  ],
  por_medium: [],
  por_campaign: [],
  cortado: { source: false, medium: false, campaign: false },
};

function rotear(falhaEm?: string) {
  vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
    if (falhaEm && path.includes(falhaEm)) throw new Error("boom");
    if (path.includes("/metrics/atendimento")) return { data: ATENDIMENTO };
    if (path.includes("/metrics/negocios")) return { data: NEGOCIOS };
    if (path.includes("/metrics/origens")) return { data: ORIGENS };
    throw new Error(`rota inesperada ${path}`);
  });
}

async function abrir(dados: DadosDosPrimeirosPassos) {
  vi.mocked(carregarPrimeirosPassos).mockResolvedValue(primeirosPassos(dados));
  const ui = await InicioPage();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  rotear();
});

describe("Início com obrigatório faltando", () => {
  it("mostra só o checklist: sem painel, sem barra lateral, sem chamar métrica", async () => {
    await abrir({ ...BASE, whatsappConectado: false });
    expect(screen.getByTestId("inicio-passo-whatsapp")).toHaveAttribute("data-feito", "nao");
    expect(screen.getByTestId("inicio-progresso")).toHaveTextContent("1 de 2 obrigatórios");
    expect(screen.queryByTestId("inicio-painel")).toBeNull();
    expect(screen.queryByTestId("inicio-barra-lateral")).toBeNull();
    expect(screen.queryByTestId("inicio-alternar-checklist")).toBeNull();
    expect(apiClient.get).not.toHaveBeenCalled();
  });
});

describe("Início com os obrigatórios cumpridos", () => {
  it("mostra o painel (as três seções, com os números) e o checklist na barra lateral", async () => {
    await abrir(BASE);
    const barra = screen.getByTestId("inicio-barra-lateral");
    expect(within(barra).getByTestId("inicio-passo-whatsapp")).toHaveAttribute("data-feito", "sim");
    expect(within(barra).getByTestId("inicio-passo-equipe")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("inicio-cartoes-origens")).toBeInTheDocument());
    const atend = await screen.findByTestId("inicio-cartoes-atendimento");
    expect(within(atend).getByText("42")).toBeInTheDocument();
    const neg = await screen.findByTestId("inicio-cartoes-negocios");
    expect(within(neg).getByText("Carteira aberta (total)")).toBeInTheDocument();
    // Origens: 10 rastreados, 25 sem origem, 3 ganhos rastreados (os 8 sem origem ficam fora), 3/10 = 30%.
    const org = screen.getByTestId("inicio-cartoes-origens");
    const cartao = (titulo: string) => within(org).getByText(titulo).closest("div")!;
    expect(cartao("Com origem rastreada")).toHaveTextContent("10");
    expect(cartao("Sem origem rastreada")).toHaveTextContent("25");
    expect(cartao("Ganhos de origem rastreada")).toHaveTextContent("3");
    expect(cartao("Taxa de ganho de origem rastreada")).toHaveTextContent("30%");
  });

  it("Esconder e Exibir recolhem e devolvem a barra, e a escolha fica lembrada por pessoa", async () => {
    const user = userEvent.setup();
    const { unmount } = await abrir(BASE);
    const botao = screen.getByTestId("inicio-alternar-checklist");
    expect(botao).toHaveTextContent("Esconder checklist");
    expect(screen.getByTestId("inicio-barra-lateral")).toHaveAttribute("data-visivel", "sim");

    await user.click(botao);
    expect(botao).toHaveTextContent("Exibir checklist");
    expect(screen.getByTestId("inicio-barra-lateral")).toHaveAttribute("data-visivel", "nao");
    expect(screen.getByTestId("inicio-barra-lateral").className).toContain("lg:hidden");
    expect(window.localStorage.getItem("inicio-checklist-escondido:user-1")).toBe("1");

    // Volta à página: a escolha da pessoa continua.
    unmount();
    await abrir(BASE);
    await waitFor(() => expect(screen.getByTestId("inicio-alternar-checklist")).toHaveTextContent("Exibir checklist"));

    await user.click(screen.getByTestId("inicio-alternar-checklist"));
    expect(screen.getByTestId("inicio-barra-lateral")).toHaveAttribute("data-visivel", "sim");
    expect(window.localStorage.getItem("inicio-checklist-escondido:user-1")).toBeNull();
  });

  it("sem localStorage (bloqueado) o botão ainda funciona e nada lança", async () => {
    const user = userEvent.setup();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    await abrir(BASE);
    await user.click(screen.getByTestId("inicio-alternar-checklist"));
    expect(screen.getByTestId("inicio-alternar-checklist")).toHaveTextContent("Exibir checklist");
    get.mockRestore();
    set.mockRestore();
  });

  it("cada seção falha sozinha: erro em Origens não derruba Atendimento nem Negócios", async () => {
    rotear("/metrics/origens");
    await abrir(BASE);
    const secaoOrigens = screen.getByTestId("inicio-secao-origens");
    await waitFor(() => expect(within(secaoOrigens).getByText("Erro ao carregar métricas.")).toBeInTheDocument());
    expect(await screen.findByTestId("inicio-cartoes-atendimento")).toBeInTheDocument();
    expect(await screen.findByTestId("inicio-cartoes-negocios")).toBeInTheDocument();
    // O botão da seção que falhou continua lá.
    expect(within(secaoOrigens).getByTestId("inicio-ver-tudo-origens")).toBeInTheDocument();
  });

  it("os três botões levam à Desempenho na aba certa, no período padrão e no escolhido", async () => {
    const user = userEvent.setup();
    await abrir(BASE);
    const href = (id: string) => screen.getByTestId(`inicio-ver-tudo-${id}`).getAttribute("href");
    expect(screen.getByTestId("inicio-ver-tudo-atendimento")).toHaveTextContent("VER TUDO EM ATENDIMENTO");
    expect(screen.getByTestId("inicio-ver-tudo-negocios")).toHaveTextContent("VER TUDO EM NEGÓCIOS");
    expect(screen.getByTestId("inicio-ver-tudo-origens")).toHaveTextContent("VER TUDO EM ORIGENS");
    expect(href("atendimento")).toBe("/app/metrics?aba=atendimento");
    expect(href("negocios")).toBe("/app/metrics");
    expect(href("origens")).toBe("/app/metrics?aba=origens");

    // O mesmo seletor de período da Desempenho: a escolha vai nos três links e na query das três rotas.
    await user.click(screen.getByRole("combobox", { name: "Período" }));
    await user.click(await screen.findByRole("option", { name: "Últimos 7 dias" }));
    await waitFor(() => expect(href("atendimento")).toBe("/app/metrics?aba=atendimento&periodo=7d"));
    expect(href("negocios")).toBe("/app/metrics?periodo=7d");
    expect(href("origens")).toBe("/app/metrics?aba=origens&periodo=7d");
    const chamadas = vi.mocked(apiClient.get).mock.calls.map((c) => String(c[0]));
    for (const rota of ["atendimento", "negocios", "origens"]) {
      expect(chamadas.filter((c) => c.includes(`/metrics/${rota}?`)).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("hrefDaDesempenho", () => {
  const base = { aba: "negocios", atalho: "30d", de: null, ate: null, funil: null, atendente: null } as const;
  it("período personalizado leva as duas datas", () => {
    const f = { ...base, atalho: "personalizado", de: "2026-10-01", ate: "2026-10-15" } as const;
    expect(hrefDaDesempenho(f, "origens")).toBe("/app/metrics?aba=origens&periodo=personalizado&de=2026-10-01&ate=2026-10-15");
    expect(hrefDaDesempenho(f, "negocios")).toBe("/app/metrics?periodo=personalizado&de=2026-10-01&ate=2026-10-15");
  });
});
