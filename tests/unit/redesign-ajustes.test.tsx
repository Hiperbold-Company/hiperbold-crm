/**
 * EQUIPE, PLANO E SEÇÕES DE CONFIGURAÇÕES NO REDESIGN — desligado é a tela de
 * sempre, ligado é a nova.
 *
 * Os componentes ganham `data-rd-ajustes="<peça>"` SÓ com a chave ligada
 * (`useMarcaDosAjustes`), e o bloco "redesign: ajustes" de `app/globals.css` os
 * desenha. Provado aqui:
 *
 *   1. DOM — sem o provedor do redesign nenhum atributo é escrito; com ele, as
 *      peças principais aparecem (lista de membros, convites, seção de formulário).
 *   2. CSS — todo seletor do bloco começa por `[data-redesign="ligado"]`.
 *
 * NÃO prova a aparência: jsdom não pinta; a semelhança com o protótipo v49 só
 * se confere na tela.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import postcss from "postcss";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rotas: {} as Record<string, unknown> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/team",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (path: string) => ({ data: h.rotas[path.split("?")[0] ?? ""] ?? [] })),
    post: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({})),
  },
}));
vi.mock("@/app/actions/settings/definirAiDecideDaEmpresa", () => ({
  definirAiDecideDaEmpresa: vi.fn(async () => ({ ok: true })),
}));

import { InterruptorAiDecide } from "@/app/app/settings/automacoes/_interruptor";
import { TeamInvitesClient } from "@/app/app/team/_components/TeamInvitesClient";
import { TeamMembersClient } from "@/app/app/team/_components/TeamMembersClient";
import { marcaDosAjustes } from "@/lib/redesign/ajustes";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const MEMBRO = {
  user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "agent",
  invited_at: null,
  accepted_at: "2026-01-01T00:00:00Z",
  revoked_at: null,
  created_at: "2026-01-01T00:00:00Z",
  email: "ana@example.com",
  full_name: "Ana",
  last_sign_in_at: null,
};

const CONVITE = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  organization_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  email: "novo@example.com",
  role: "agent",
  interface_settings: null,
  invited_by: null,
  inviter_name: null,
  email_dispatched: true,
  created_at: "2026-11-20T00:00:00Z",
  last_sent_at: "2026-11-20T00:00:00Z",
  resend_count: 0,
  expires_at: "2026-12-20T00:00:00Z",
  accepted_at: null,
  revoked_at: null,
  status: "pendente",
};

function ligado({ children }: { children: ReactNode }) {
  return <ProvedorDoRedesign ligado>{children}</ProvedorDoRedesign>;
}

function comQuery(filho: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{filho}</QueryClientProvider>;
}

function pecas(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-rd-ajustes]")).map((e) => e.getAttribute("data-rd-ajustes") ?? "");
}

afterEach(() => {
  cleanup();
  h.rotas = {};
});

describe("redesign: ajustes, DOM", () => {
  it("desligado, membros, convites e seção de formulário não escrevem nenhum data-rd-ajustes", async () => {
    h.rotas = { "/api/v1/team": [MEMBRO], "/api/v1/team/invites": [CONVITE] };
    const { container } = render(
      comQuery(
        <>
          <TeamMembersClient currentUserId="x" canManage />
          <TeamInvitesClient canManage />
          <InterruptorAiDecide ligado idioma="pt-BR" />
        </>,
      ),
    );
    await screen.findByText("ana@example.com");
    await screen.findByText("novo@example.com");
    expect(container.querySelectorAll("[data-rd-ajustes]")).toHaveLength(0);
  });

  it("ligado, a equipe marca a lista de membros, os convites e a lista de convites", async () => {
    h.rotas = { "/api/v1/team": [MEMBRO], "/api/v1/team/invites": [CONVITE] };
    const { container } = render(
      comQuery(
        <>
          <TeamMembersClient currentUserId="x" canManage />
          <TeamInvitesClient canManage />
        </>,
      ),
      { wrapper: ligado },
    );
    await screen.findByText("ana@example.com");
    await screen.findByText("novo@example.com");
    const marcadas = pecas(container);
    expect(marcadas).toContain("convites");
    expect(marcadas.filter((p) => p === "lista")).toHaveLength(2);
    expect(screen.getByText("ana@example.com")).toBeTruthy();
  });

  it("ligado, a seção de formulário é marcada e o conteúdo segue o mesmo", () => {
    const { container } = render(<InterruptorAiDecide ligado idioma="pt-BR" />, { wrapper: ligado });
    expect(pecas(container)).toContain("secao");
    expect(screen.getByRole("switch")).toBeTruthy();
  });

  it("marcaDosAjustes (página de servidor): ligada devolve a peça, desligada undefined", () => {
    expect(marcaDosAjustes(true)("cabecalho")).toBe("cabecalho");
    expect(marcaDosAjustes(false)("cabecalho")).toBeUndefined();
    expect(marcaDosAjustes(true)("barra-de-uso")).toBe("barra-de-uso");
  });
});

describe("redesign: ajustes, CSS escopado pela chave", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: ajustes ─";
  const FIM = "/* redesign: ajustes — fim";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
    if (css.indexOf(INICIO, i + 1) >= 0) throw new Error("marcador de início repetido");
    return css.slice(i, f);
  }

  function erros(css: string): { regras: number; erros: string[] } {
    const out: string[] = [];
    let regras = 0;
    postcss.parse(css).walkAtRules((at) => {
      if (at.name !== "media") out.push(`@${at.name} não é permitido`);
    });
    postcss.parse(css).walkRules((r) => {
      regras++;
      for (const p of r.selectors) if (!p.trim().startsWith(ESCOPO)) out.push(`seletor sem escopo: ${p}`);
    });
    postcss.parse(css).walkDecls((d) => {
      if (d.important) out.push(`!important em ${d.prop}`);
    });
    return { regras, erros: out };
  }

  it('o bloco existe e todo seletor começa por [data-redesign="ligado"]', () => {
    const r = erros(bloco(CSS));
    expect(r.regras).toBeGreaterThan(15);
    expect(r.erros).toEqual([]);
  });

  it("controle negativo: a régua reprova seletor sem escopo", () => {
    const r = erros(`.x { color: red; } ${ESCOPO} .a, .b { color: red; }`);
    expect(r.erros).toContain("seletor sem escopo: .x");
    expect(r.erros).toContain("seletor sem escopo: .b");
  });
});
