/**
 * O PAINEL DA PLATAFORMA NO REDESIGN — desligado é o painel de sempre.
 *
 *   1. DOM — sem o provedor nenhum `data-rd-plataforma` é escrito; com ele a
 *      casca, o menu, o topo e o conteúdo aparecem.
 *   2. CSS — todo seletor do bloco "redesign: plataforma" começa por
 *      `[data-redesign="ligado"]` (com controle negativo).
 *
 * NÃO prova a aparência: jsdom não pinta.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import postcss from "postcss";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/tenants",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/admin/BuscaDoAdmin", () => ({ BuscaDoAdmin: () => null }));
vi.mock("@/components/admin/PlatformModeBanner", () => ({ PlatformModeBanner: () => null }));

import { AdminShell } from "@/components/admin/AdminShell";
import { marcaDaPlataforma } from "@/lib/redesign/plataforma";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

function ligado({ children }: { children: ReactNode }) {
  return <ProvedorDoRedesign ligado>{children}</ProvedorDoRedesign>;
}

const tela = (
  <AdminShell userEmail="a@b.c">
    <p>conteudo</p>
  </AdminShell>
);

afterEach(cleanup);

describe("redesign: plataforma, DOM", () => {
  it("desligado, a casca não escreve nenhum data-rd-plataforma", () => {
    const { container } = render(tela);
    expect(container.querySelectorAll("[data-rd-plataforma]")).toHaveLength(0);
    expect(document.body.querySelectorAll("[data-rd-plataforma]")).toHaveLength(0);
  });

  it("ligado, a casca marca casca, menu, itens, topo e conteúdo", () => {
    const { container } = render(tela, { wrapper: ligado });
    const pecas = Array.from(container.querySelectorAll("[data-rd-plataforma]")).map((e) =>
      e.getAttribute("data-rd-plataforma"),
    );
    for (const p of ["casca", "menu", "menu-topo", "menu-marca", "menu-lista", "menu-item", "menu-rodape", "topo", "conteudo"]) {
      expect(pecas).toContain(p);
    }
    expect(container.querySelector("main")?.textContent).toBe("conteudo");
  });

  it("marcaDaPlataforma (página de servidor): ligada devolve a peça, desligada undefined", () => {
    expect(marcaDaPlataforma(true)("titulo")).toBe("titulo");
    expect(marcaDaPlataforma(false)("titulo")).toBeUndefined();
  });
});

describe("redesign: plataforma, CSS escopado pela chave", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: plataforma ───";
  const FIM = "/* redesign: plataforma — fim";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
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
