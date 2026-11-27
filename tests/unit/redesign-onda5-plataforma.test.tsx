/**
 * ONDA 5 DO REDESIGN — PLATAFORMA (`/admin`) no v49.
 *
 * Retratos da chave DESLIGADA, escritos ANTES da onda 5 contra o código de
 * sempre. Com a chave desligada, o HTML destes componentes tem de ser o mesmo,
 * byte a byte. Com ela ligada, os controles (rótulo, testid, disabled, href,
 * name) são o mesmo conjunto: a onda só muda a aparência.
 *
 * Também prova o cartão "Novo visual" pelo comportamento (o POST que sai pela
 * fronteira da API, com o id da empresa e o valor novo), com a chave ligada e
 * desligada, e cobra o escopo do bloco CSS `redesign: onda5 plataforma`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderBase, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import postcss from "postcss";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminTenantRow } from "@/hooks/useAdminTenants";
import type { AdminUserRow } from "@/hooks/useAdminUsers";

const h = vi.hoisted(() => ({
  rotas: {} as Record<string, unknown>,
  post: vi.fn(async (_p: string, _b?: unknown) => ({ data: { ligado: true } })),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/admin/tenants",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (p: string) => ({ data: h.rotas[p.split("?")[0] ?? ""] ?? [] })),
    post: h.post,
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({})),
  },
}));

import { UsersClient } from "@/app/admin/(protected)/users/_client";
import { TenantsClient } from "@/app/admin/(protected)/tenants/_client";
import { CartaoDoNovoVisual } from "@/components/admin/tenants/CartaoDoNovoVisual";
import { TenantsTable, TenantsTableSkeleton } from "@/components/admin/tenants/TenantsTable";
import { UsersTableAdmin, UsersTableAdminSkeleton } from "@/components/admin/users/UsersTableAdmin";
import { ProvedorDeConfirmacao } from "@/components/ui/confirmar";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import { marcaDaPlataforma } from "@/lib/redesign/plataforma";

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

const ORG_ID = "22222222-2222-4222-8222-222222222222";

function empresa(parcial: Partial<AdminTenantRow>): AdminTenantRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "clinica-bem-estar",
    display_name: "Clínica Bem Estar",
    legal_name: null,
    cnpj: "12345678000190",
    status: "active",
    onboarded_at: "2026-01-15T12:00:00.000Z",
    suspended_at: null,
    suspended_kind: null,
    created_at: "2026-03-14T12:00:00.000Z",
    user_count: [{ count: 12 }],
    conversations_count: [{ count: 340 }],
    ...parcial,
  };
}

const EMPRESAS: AdminTenantRow[] = [
  empresa({}),
  empresa({
    id: "33333333-3333-4333-8333-333333333333",
    slug: "lima-arquitetura",
    display_name: "Lima Arquitetura",
    cnpj: null,
    onboarded_at: null,
    created_at: "2026-11-10T12:00:00.000Z",
    user_count: [{ count: 3 }],
    conversations_count: null,
  }),
  empresa({
    id: "44444444-4444-4444-8444-444444444444",
    slug: "studio-corpo",
    display_name: "Studio Corpo em Foco",
    status: "suspended",
    suspended_at: "2026-08-08T12:00:00.000Z",
    suspended_kind: "administrativa",
    created_at: "2026-08-08T12:00:00.000Z",
  }),
];

const PESSOAS: AdminUserRow[] = [
  {
    user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    organization_id: "11111111-1111-4111-8111-111111111111",
    role: "admin",
    accepted_at: "2026-01-01T12:00:00Z",
    revoked_at: null,
    tenant_name: "Clínica Bem Estar",
    tenant_slug: "clinica-bem-estar",
    email: "helena@clinicabemestar.com.br",
    full_name: "Helena Prado",
    last_sign_in_at: "2026-11-24T12:00:00Z",
    created_at: "2026-01-01T12:00:00Z",
  },
  {
    user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    organization_id: "44444444-4444-4444-8444-444444444444",
    role: "agent",
    accepted_at: null,
    revoked_at: "2026-10-28T12:00:00Z",
    tenant_name: "Studio Corpo em Foco",
    tenant_slug: "studio-corpo",
    email: "marcos@corpoemfoco.com.br",
    full_name: null,
    last_sign_in_at: null,
    created_at: "2026-02-01T12:00:00Z",
  },
];

function Envoltorio({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <IdiomaProvider locale="pt-BR">
        <ProvedorDeConfirmacao>{children}</ProvedorDeConfirmacao>
      </IdiomaProvider>
    </QueryClientProvider>
  );
}

function render(ui: ReactNode) {
  return renderBase(<Envoltorio>{ui}</Envoltorio>);
}

const semFim = { hasNextPage: false, isFetchingNextPage: false, onLoadMore: () => {} };

interface Tela {
  nome: string;
  ui: () => ReactNode;
  /** Texto que prova que a tela terminou de montar (as listas carregam pela API). */
  pronto: string;
}

const TELAS: Tela[] = [
  { nome: "Empresas (lista carregada)", ui: () => <TenantsClient />, pronto: "Studio Corpo em Foco" },
  { nome: "Empresas (tabela vazia)", ui: () => <TenantsTable data={[]} {...semFim} />, pronto: "Nenhum tenant encontrado" },
  { nome: "Usuários (lista carregada)", ui: () => <UsersClient />, pronto: "helena@clinicabemestar.com.br" },
  { nome: "Usuários (tabela vazia)", ui: () => <UsersTableAdmin data={[]} {...semFim} />, pronto: "Nenhum usuário encontrado" },
  {
    nome: "Novo visual (desligado, pode escrever)",
    ui: () => <CartaoDoNovoVisual organizationId={ORG_ID} ligado={false} podeEscrever />,
    pronto: "Novo visual",
  },
  {
    nome: "Novo visual (ligado, só leitura)",
    ui: () => <CartaoDoNovoVisual organizationId={ORG_ID} ligado podeEscrever={false} />,
    pronto: "Novo visual",
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T15:00:00Z"));
  h.rotas = { "/api/v1/admin/tenants": EMPRESAS, "/api/v1/admin/users": PESSOAS };
  h.post.mockClear();
  h.refresh.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.rotas = {};
});

describe("onda 5 — Plataforma, retrato da chave DESLIGADA", () => {
  for (const tela of TELAS) {
    it(`${tela.nome}`, async () => {
      const { container } = render(<ProvedorDoRedesign ligado={false}>{tela.ui()}</ProvedorDoRedesign>);
      await screen.findAllByText(new RegExp(tela.pronto));
      // O id que o React gera (`radix-_r_8d_`) depende da ordem de montagem dos casos; fora dele, byte a byte.
      expect(container.innerHTML.replace(/_r_[a-z0-9]+_/g, "_r_")).toMatchSnapshot();
    });
  }
});

/* ── Chave LIGADA: nenhum controle muda ─────────────────────────────────── */

/** Botões, links e campos na ordem do DOM: rótulo, testid, disabled, href e name. */
function controles(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [role='tab'], [role='switch'], [role='combobox']"),
  ).map((el) =>
    [
      el.tagName,
      (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("data-testid") ?? "",
      el.hasAttribute("disabled") ? "disabled" : "",
      el.getAttribute("href") ?? "",
      el.getAttribute("name") ?? "",
      (el.getAttribute("id") ?? "").replace(/_r_[a-z0-9]+_/g, "_r_"),
    ].join(" | "),
  );
}

describe("onda 5 — Plataforma com a chave LIGADA", () => {
  for (const tela of TELAS) {
    it(`${tela.nome}: mesmos botões, links e campos ligado e desligado`, async () => {
      const off = render(<ProvedorDoRedesign ligado={false}>{tela.ui()}</ProvedorDoRedesign>);
      await screen.findAllByText(new RegExp(tela.pronto));
      const desligado = controles(off.container);
      cleanup();
      const on = render(<ProvedorDoRedesign ligado>{tela.ui()}</ProvedorDoRedesign>);
      await screen.findAllByText(new RegExp(tela.pronto));
      expect(controles(on.container)).toEqual(desligado);
    });
  }

  it("desligada, nenhuma tela escreve data-rd-plataforma", async () => {
    for (const tela of TELAS) {
      const { container } = render(<ProvedorDoRedesign ligado={false}>{tela.ui()}</ProvedorDoRedesign>);
      await screen.findAllByText(new RegExp(tela.pronto));
      expect(container.querySelectorAll("[data-rd-plataforma]")).toHaveLength(0);
      cleanup();
    }
  });
});

/* ── O cartão "Novo visual": comportamento, ligado e desligado ───────────── */

describe("CartaoDoNovoVisual — liga e desliga o novo visual de UMA empresa", () => {
  for (const chave of [false, true]) {
    describe(`chave do redesign ${chave ? "LIGADA" : "DESLIGADA"}`, () => {
      it("o switch reflete o estado lido no servidor", () => {
        render(
          <ProvedorDoRedesign ligado={chave}>
            <CartaoDoNovoVisual organizationId={ORG_ID} ligado podeEscrever />
          </ProvedorDoRedesign>,
        );
        const sw = screen.getByRole("switch");
        expect(sw.getAttribute("id")).toBe(`novo-visual-${ORG_ID}`);
        expect(sw.getAttribute("aria-checked")).toBe("true");
        expect(screen.getByTestId("novo-visual").textContent).toContain("Ligado");
      });

      it("clicar desligado → POST na rota DESTA empresa com ligado: true, e o rótulo vira", async () => {
        const user = userEvent.setup();
        render(
          <ProvedorDoRedesign ligado={chave}>
            <CartaoDoNovoVisual organizationId={ORG_ID} ligado={false} podeEscrever />
          </ProvedorDoRedesign>,
        );
        expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
        await user.click(screen.getByRole("switch"));
        await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
        expect(h.post).toHaveBeenCalledWith(`/api/v1/admin/tenants/${ORG_ID}/redesign`, { ligado: true });
        await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
        expect(screen.getByTestId("novo-visual").textContent).toContain("Ligado");
        expect(h.refresh).toHaveBeenCalled();
      });

      it("clicar ligado → POST com ligado: false", async () => {
        const user = userEvent.setup();
        render(
          <ProvedorDoRedesign ligado={chave}>
            <CartaoDoNovoVisual organizationId={ORG_ID} ligado podeEscrever />
          </ProvedorDoRedesign>,
        );
        await user.click(screen.getByRole("switch"));
        await waitFor(() => expect(h.post).toHaveBeenCalledWith(`/api/v1/admin/tenants/${ORG_ID}/redesign`, { ligado: false }));
        await waitFor(() => expect(screen.getByTestId("novo-visual").textContent).toContain("Desligado"));
      });

      it("sem permissão de escrita o switch fica desabilitado e nada sai", async () => {
        const user = userEvent.setup();
        render(
          <ProvedorDoRedesign ligado={chave}>
            <CartaoDoNovoVisual organizationId={ORG_ID} ligado={false} podeEscrever={false} />
          </ProvedorDoRedesign>,
        );
        const sw = screen.getByRole("switch");
        expect(sw.hasAttribute("disabled")).toBe(true);
        await user.click(sw);
        expect(h.post).not.toHaveBeenCalled();
      });
    });
  }
});

/* ── Chave LIGADA: o avatar é decorativo e as peças aparecem ─────────────── */

describe("onda 5 — peças marcadas com a chave ligada", () => {
  it("Empresas: filtros, tabela e avatar de iniciais aria-hidden, com o nome ainda legível", async () => {
    const { container } = render(
      <ProvedorDoRedesign ligado>
        <TenantsClient />
      </ProvedorDoRedesign>,
    );
    await screen.findAllByText(/Studio Corpo em Foco/);
    for (const peca of ["cabecalho", "filtros", "tabela", "nome", "avatar"]) {
      expect(container.querySelector(`[data-rd-plataforma="${peca}"]`), peca).not.toBeNull();
    }
    const avatares = Array.from(container.querySelectorAll('[data-rd-plataforma="avatar"]'));
    expect(avatares.map((a) => a.textContent)).toEqual(["CE", "LA", "SF"]);
    for (const a of avatares) expect(a.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("cell", { name: "Clínica Bem Estar" })).toBeTruthy();
  });

  it("Usuários: avatar só onde há nome; sem nome segue o travessão", async () => {
    const { container } = render(
      <ProvedorDoRedesign ligado>
        <UsersClient />
      </ProvedorDoRedesign>,
    );
    await screen.findAllByText(/helena@clinicabemestar/);
    const avatares = Array.from(container.querySelectorAll('[data-rd-plataforma="avatar"]'));
    expect(avatares.map((a) => a.textContent)).toEqual(["HP"]);
    expect(container.querySelector('[data-rd-plataforma="filtros"]')).not.toBeNull();
  });

  it("marcaDaPlataforma: as peças novas seguem a mesma regra pura", () => {
    for (const p of ["filtros", "tabela", "grade-de-cartoes", "formulario", "selo"] as const) {
      expect(marcaDaPlataforma(true)(p)).toBe(p);
      expect(marcaDaPlataforma(false)(p)).toBeUndefined();
    }
  });
});

/* ── CSS: o bloco da onda 5 é todo escopado pela chave ───────────────────── */

describe("redesign: onda5 plataforma, CSS escopado pela chave", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: onda5 plataforma ───";
  const FIM = "/* redesign: onda5 plataforma — fim";
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
    const raiz = postcss.parse(css);
    raiz.walkAtRules((at) => {
      if (at.name !== "media") out.push(`@${at.name} não é permitido`);
    });
    raiz.walkRules((r) => {
      regras++;
      for (const p of r.selectors) if (!p.trim().startsWith(ESCOPO)) out.push(`seletor sem escopo: ${p}`);
    });
    raiz.walkDecls((d) => {
      if (d.important) out.push(`!important em ${d.prop}`);
      if (/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(d.value)) out.push(`cor literal em ${d.prop}: ${d.value}`);
    });
    return { regras, erros: out };
  }

  it("o bloco existe, só a passada do celular vem depois dele, e todo seletor começa por [data-redesign=\"ligado\"]", () => {
    const r = erros(bloco(CSS));
    expect(r.regras).toBeGreaterThan(15);
    expect(r.erros).toEqual([]);
    // Depois dele, só o bloco da passada do celular (parte 3 da onda 5), que se
    // declara o último do arquivo no próprio teste.
    const depois = CSS.slice(CSS.indexOf(FIM)).split("\n").filter((l) => l.trim());
    expect(depois[0]).toContain(FIM);
    expect(depois[1]).toContain("/* redesign: onda5 celular ───");
  });

  it("controle negativo: a régua reprova seletor sem escopo, !important e cor literal", () => {
    const r = erros(`.x { color: red; } ${ESCOPO} .a { color: #fff !important; }`);
    expect(r.erros).toContain("seletor sem escopo: .x");
    expect(r.erros).toContain("!important em color");
    expect(r.erros.some((e) => e.startsWith("cor literal"))).toBe(true);
  });
});

/* ── Esqueletos: a chave só acrescenta o atributo ────────────────────────── */

describe("onda 5 — esqueletos das listas", () => {
  for (const [nome, ui] of [
    ["Empresas", () => <TenantsTableSkeleton />],
    ["Usuários", () => <UsersTableAdminSkeleton />],
  ] as const) {
    it(`${nome}: ligado é o desligado mais data-rd-plataforma, e só isso`, () => {
      const off = render(<ProvedorDoRedesign ligado={false}>{ui()}</ProvedorDoRedesign>).container.innerHTML;
      cleanup();
      const on = render(<ProvedorDoRedesign ligado>{ui()}</ProvedorDoRedesign>).container.innerHTML;
      expect(off).not.toContain("data-rd-plataforma");
      expect(on).toContain('data-rd-plataforma="tabela"');
      expect(on.replace(/ data-rd-plataforma="[^"]*"/g, "")).toBe(off);
    });
  }
});
