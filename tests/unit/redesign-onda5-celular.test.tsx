/**
 * ONDA 5 DO REDESIGN — A PASSADA NO CELULAR (390px).
 *
 * A barra de abas nova (`BarraInferiorNova`) e o "Mais" do celular só existem
 * com a chave LIGADA, então não há HTML desligado a preservar neles. O que a
 * passada não pode mudar é o CONJUNTO DE CONTROLES: os mesmos destinos (href,
 * rótulo, aria-label, aria-current), os mesmos botões, na mesma ordem. O
 * retrato abaixo foi gravado ANTES de qualquer edição, contra o código de
 * sempre; a passada só pode mudar a aparência.
 *
 * O resto da passada é CSS (`/* redesign: onda5 celular *\/` no fim de
 * `app/globals.css`), todo sob `[data-redesign="ligado"]` e dentro de
 * `@media (max-width: 767px)` — o computador não muda.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pathname: "/app/contacts",
  admin: true,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { is_platform_admin: h.admin, support: null },
    activeOrg: {
      orgId: "org-1",
      name: "Clínica Bem Estar",
      role: "admin",
      interface_settings: undefined,
      modulos_ligados: [],
      capacidades_ligadas: [],
    },
    signOut: vi.fn(),
  }),
  useUser: () => ({
    full_name: "Rosana Silva",
    email: "rosana@example.com",
    is_platform_admin: h.admin,
    support: null,
    organizations: [{ id: "org-1" }, { id: "org-2" }],
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/navigation/prefetchPorIntencao", () => ({ usePrefetchPorIntencao: () => () => ({}) }));
vi.mock("@/components/shell/ContadorDaFila", () => ({
  ContadorDaFila: () => <span data-testid="contador-fila" />,
}));
vi.mock("@/components/shell/ContadorDeCasos", () => ({
  ContadorDeCasos: () => <span data-testid="contador-casos" />,
}));
vi.mock("@/components/shell/SeletorDeIdioma", () => ({
  useEscolherIdioma: () => ({ idioma: "pt-BR", escolher: vi.fn(), salvando: false }),
}));
vi.mock("@/components/theme/theme-toggle", () => ({
  useCicloDoTema: () => ({ theme: "light", setTheme: vi.fn(), cycle: vi.fn() }),
}));
vi.mock("@/components/shell/UserMenu", () => ({
  abrirModoAdministrador: vi.fn(),
  navegarPeloItemDoMenu: vi.fn(),
}));
vi.mock("@/components/shell/redesign/MarcaECartaoDaEmpresa", () => ({
  CartaoDaEmpresa: () => <button type="button">Cartão da empresa</button>,
  MarcaDoMenu: () => null,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { BarraInferiorNova } from "@/components/shell/redesign/BarraInferiorNova";
import { ProvedorDaCentralDeAjuda } from "@/lib/ajuda/contexto";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T15:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function montar() {
  return render(
    <ProvedorDoRedesign ligado>
      <ProvedorDaCentralDeAjuda base="https://ajuda.example.com">
        <BarraInferiorNova />
      </ProvedorDaCentralDeAjuda>
    </ProvedorDoRedesign>,
  );
}

/** Todo controle no documento (o Sheet desenha em portal no `body`), na ordem do DOM. */
function controles(): string[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>("a, button, input, select, textarea, [role='radio'], [role='radiogroup'], [role='group']"),
  ).map((el) =>
    [
      el.tagName.toLowerCase(),
      el.getAttribute("href") ?? "",
      el.getAttribute("role") ?? "",
      el.getAttribute("type") ?? "",
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("aria-current") ?? "",
      el.getAttribute("aria-checked") ?? "",
      el.getAttribute("data-testid") ?? "",
      el.getAttribute("target") ?? "",
      el.hasAttribute("disabled") ? "disabled" : "",
      (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    ].join(" | "),
  );
}

describe("onda 5 celular — a barra de abas e o \"Mais\" mantêm os mesmos controles", () => {
  for (const caso of [
    { nome: "admin da plataforma em Contatos", pathname: "/app/contacts", admin: true },
    { nome: "admin da empresa em Conversas", pathname: "/app/inbox", admin: false },
  ]) {
    it(`${caso.nome}: barra fechada`, () => {
      h.pathname = caso.pathname;
      h.admin = caso.admin;
      montar();
      expect(controles()).toMatchSnapshot();
    });

    it(`${caso.nome}: "Mais" aberto`, () => {
      h.pathname = caso.pathname;
      h.admin = caso.admin;
      montar();
      const barra = screen.getByRole("navigation", { name: "Navegação rápida" });
      fireEvent.click(barra.querySelector("button")!);
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(controles()).toMatchSnapshot();
    });
  }
});

/* ── CSS: o bloco do celular é todo escopado pela chave e pelo corte do celular ── */

describe("redesign: onda5 celular, CSS escopado pela chave", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: onda5 celular ───";
  const FIM = "/* redesign: onda5 celular — fim";
  const ESCOPO = '[data-redesign="ligado"]';
  const CORTE = "(max-width: 767px)";

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
      else if (at.params.trim() !== CORTE) out.push(`@media ${at.params} não é o corte do celular`);
    });
    raiz.walkRules((r) => {
      regras++;
      if (r.parent?.type !== "atrule") out.push(`regra fora do @media do celular: ${r.selector}`);
      for (const p of r.selectors) if (!p.trim().startsWith(ESCOPO)) out.push(`seletor sem escopo: ${p}`);
    });
    raiz.walkDecls((d) => {
      if (d.important) out.push(`!important em ${d.prop}`);
      if (/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(d.value)) out.push(`cor literal em ${d.prop}: ${d.value}`);
    });
    return { regras, erros: out };
  }

  it("o bloco existe, é o último do arquivo, e toda regra é do celular e escopada", () => {
    const r = erros(bloco(CSS));
    expect(r.regras).toBeGreaterThan(10);
    expect(r.erros).toEqual([]);
    expect(CSS.slice(CSS.indexOf(FIM)).split("\n").filter((l) => l.trim()).length).toBe(1);
  });

  it("controle negativo: a régua reprova regra fora do @media, outro corte, sem escopo e cor literal", () => {
    const r = erros(
      `${ESCOPO} .a { color: red; } @media (min-width: 768px) { ${ESCOPO} .b { color: #fff; } } @media ${CORTE} { .c { color: red !important; } }`,
    );
    expect(r.erros).toContain(`regra fora do @media do celular: ${ESCOPO} .a`);
    expect(r.erros.some((e) => e.includes("não é o corte do celular"))).toBe(true);
    expect(r.erros).toContain("seletor sem escopo: .c");
    expect(r.erros).toContain("!important em color");
    expect(r.erros.some((e) => e.startsWith("cor literal"))).toBe(true);
  });
});
