/**
 * 403, 500 e acesso negado do admin no redesign, em QUALQUER idioma, e o
 * cabeçalho/cor de destaque do painel da plataforma.
 *
 * (a) desligada nenhuma peça nova escreve `data-rd-sistema`; (b) ligada as peças
 * aparecem em pt-BR, en e es, com o MESMO conjunto de peças nos três idiomas e o
 * texto traduzido. NÃO prova a aparência: jsdom não pinta.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ligado: false, locale: "pt-BR" as string }));

// A marca vem do banco (platform_branding). Sem .env.local (como no CI) o
// cliente aponta para um host .invalid e a leitura fica pendurada até o timeout.
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Marca Teste", logoUrl: null, accent: "#123456" }),
}));
vi.mock("@/lib/redesign/chave", () => ({ redesignNaRequisicao: async () => h.ligado }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { user_metadata: { locale: h.locale } } } }) },
  }),
}));

import ForbiddenPage from "@/app/403/page";
import InternalErrorPage from "@/app/500/page";
import AdminForbiddenPage from "@/app/admin/forbidden/page";

afterEach(() => {
  cleanup();
  h.ligado = false;
  h.locale = "pt-BR";
});

const PAGINAS = [
  ["403", ForbiddenPage],
  ["500", InternalErrorPage],
  ["admin/forbidden", AdminForbiddenPage],
] as const;

function pecas(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-rd-sistema]"))
    .map((e) => e.getAttribute("data-rd-sistema") as string)
    .sort();
}

describe("redesign: sistema — 403, 500 e acesso negado do admin em todos os idiomas", () => {
  for (const [nome, Pagina] of PAGINAS) {
    for (const locale of ["pt-BR", "en", "es"]) {
      it(`${nome} desligada em ${locale}: nenhum data-rd-sistema`, async () => {
        h.ligado = false;
        h.locale = locale;
        const { container } = render(await Pagina());
        expect(pecas(container)).toEqual([]);
      });
    }

    it(`${nome} ligada: as mesmas peças em pt-BR, en e es`, async () => {
      h.ligado = true;
      const porIdioma: Record<string, string[]> = {};
      const titulo: Record<string, string> = {};
      for (const locale of ["pt-BR", "en", "es"]) {
        h.locale = locale;
        const { container } = render(await Pagina());
        porIdioma[locale] = pecas(container);
        titulo[locale] = container.querySelector('[data-rd-sistema="titulo"]')?.textContent ?? "";
        cleanup();
      }
      for (const p of ["pagina", "cartao", "titulo", "texto", "acoes"]) {
        expect(porIdioma["pt-BR"], p).toContain(p);
      }
      expect(porIdioma.en).toEqual(porIdioma["pt-BR"]);
      expect(porIdioma.es).toEqual(porIdioma["pt-BR"]);
      expect(titulo.en).not.toBe("");
      expect(titulo.es).not.toBe("");
    });
  }
});

describe("redesign: plataforma — cabeçalho e cor de destaque (CSS)", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const bloco = CSS.slice(
    CSS.indexOf("/* redesign: plataforma ───"),
    CSS.indexOf("/* redesign: plataforma — fim"),
  );

  it("--plat nasce de token que já existe, dentro do bloco e escopado pela chave", () => {
    expect(bloco).toMatch(/\[data-redesign="ligado"\] \[data-rd-plataforma="casca"\][^{]*\{[^}]*--plat: var\(--color-ia\)/);
    expect(bloco).toContain("--plat-soft:");
    expect(bloco).toContain("--plat-fg:");
    // fora do bloco ninguém define --plat
    expect(CSS.replace(bloco, "")).not.toMatch(/--plat\s*:/);
  });

  it("o cabeçalho da página e o item ativo do menu usam a cor da plataforma", () => {
    expect(bloco).toMatch(/:has\(> h1\)[^{]*::before/);
    expect(bloco).toMatch(/menu-item"\]\[aria-current="page"\] \{[^}]*var\(--plat\)/);
  });
});
