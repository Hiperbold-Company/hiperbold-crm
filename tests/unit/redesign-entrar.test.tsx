/**
 * AS TELAS DE ENTRADA NO REDESIGN — desligado é a tela de sempre, ligado é a nova.
 *
 * Nenhuma tela foi duplicada: o layout de `app/(public)` (Entrar, criar conta,
 * convite, recuperar senha, MFA) e o de `app/onboarding` ganham
 * `data-rd-entrar="<peça>"` SÓ com a chave ligada (`marcaDeEntrar`), e o bloco
 * "redesign: entrar" de `app/globals.css` os desenha. Provado aqui:
 *
 *   1. DOM — desligada nenhum atributo é escrito; ligada, as peças principais
 *      (página, cartão, logo) aparecem e o conteúdo segue intacto.
 *   2. CSS — todo seletor do bloco começa por `[data-redesign="ligado"]`.
 *
 * NÃO prova a aparência: jsdom não pinta; a semelhança com o protótipo v49 só
 * se confere na tela.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import postcss from "postcss";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ligado: false }));

vi.mock("@/lib/redesign/chave", () => ({ redesignLigado: () => h.ligado }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Marca X", logoUrl: "https://exemplo.test/logo.png", logoDarkUrl: null }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));

import PublicLayout from "@/app/(public)/layout";
import { marcaDeEntrar } from "@/lib/redesign/entrar";

async function montar() {
  const el = await PublicLayout({ children: <h1>Entrar</h1> });
  return render(el);
}

afterEach(() => {
  cleanup();
  h.ligado = false;
});

describe("redesign: entrar, DOM", () => {
  it("desligado, a casca das telas de acesso não escreve nenhum data-rd-entrar", async () => {
    h.ligado = false;
    const { container } = await montar();
    expect(container.querySelectorAll("[data-rd-entrar]")).toHaveLength(0);
    expect(screen.getByTestId("logo-da-fachada")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Entrar" })).toBeTruthy();
  });

  it("ligado, a casca marca página, cartão e logo e mantém o conteúdo", async () => {
    h.ligado = true;
    const { container } = await montar();
    const pecas = Array.from(container.querySelectorAll("[data-rd-entrar]")).map((e) => e.getAttribute("data-rd-entrar"));
    for (const p of ["pagina", "cartao", "logo"]) expect(pecas).toContain(p);
    expect(screen.getByTestId("logo-da-fachada").getAttribute("alt")).toBe("Marca X");
    expect(container.querySelector('[data-rd-entrar="cartao"] h1')?.textContent).toBe("Entrar");
  });

  it("o layout do primeiro acesso marca página, cabeçalho e conteúdo pela mesma regra", () => {
    const fonte = readFileSync(join(process.cwd(), "app/onboarding/layout.tsx"), "utf8");
    expect(fonte).toContain("marcaDeEntrar(redesignLigado())");
    for (const p of ["pagina", "cabecalho", "conteudo"]) expect(fonte).toContain(`rd("${p}")`);
  });

  it("marcaDeEntrar: ligada devolve a peça, desligada undefined", () => {
    expect(marcaDeEntrar(true)("cartao")).toBe("cartao");
    expect(marcaDeEntrar(false)("cartao")).toBeUndefined();
  });
});

describe("redesign: entrar, CSS escopado pela chave", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: entrar ";
  const FIM = "/* redesign: entrar — fim";
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
