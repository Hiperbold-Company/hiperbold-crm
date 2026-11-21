/**
 * AS PÁGINAS DE SISTEMA NO REDESIGN — desligado é a página de sempre.
 *
 * As páginas ganham `data-rd-sistema="<peça>"` SÓ com a chave ligada
 * (`marcaDoSistema`), e o bloco "redesign: sistema" de `app/globals.css` as
 * desenha. Provado aqui: (a) desligada nenhum atributo é escrito; (b) ligada as
 * peças principais aparecem; (c) todo seletor do bloco começa por
 * `[data-redesign="ligado"]`, com controle negativo.
 *
 * NÃO prova a aparência: jsdom não pinta.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import postcss from "postcss";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ligado: false }));

vi.mock("@/lib/redesign/chave", () => ({ redesignLigado: () => h.ligado }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
vi.mock("@/app/actions/auth/signOut", () => ({ signOut: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(() => "evt") }));
vi.mock("@/lib/erros/relatar-erro-do-navegador", () => ({ relatarErroDoNavegador: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import ForbiddenPage from "@/app/403/page";
import InternalErrorPage from "@/app/500/page";
import ServiceUnavailablePage from "@/app/503/page";
import AcessoRevogadoPage from "@/app/acesso-revogado/page";
import NotFound from "@/app/not-found";
import { SegmentError } from "@/components/feedback/SegmentError";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import { marcaDoSistema } from "@/lib/redesign/sistema";

afterEach(() => {
  cleanup();
  h.ligado = false;
});

async function paginas() {
  return [
    await ForbiddenPage(),
    await InternalErrorPage(),
    ServiceUnavailablePage(),
    await NotFound(),
    await AcessoRevogadoPage(),
  ];
}

describe("redesign: sistema — DOM", () => {
  it("a regra pura: ligada devolve a peça, desligada undefined", () => {
    expect(marcaDoSistema(true)("cartao")).toBe("cartao");
    expect(marcaDoSistema(false)("cartao")).toBeUndefined();
  });

  it("desligada: nenhuma página escreve data-rd-sistema", async () => {
    h.ligado = false;
    for (const pagina of await paginas()) {
      const { container } = render(pagina);
      expect(container.querySelector("[data-rd-sistema]")).toBeNull();
      cleanup();
    }
    const { container } = render(<SegmentError error={new Error("x")} reset={() => {}} />);
    expect(container.querySelector("[data-rd-sistema]")).toBeNull();
  });

  it("ligada: as peças principais aparecem em cada página", async () => {
    h.ligado = true;
    for (const pagina of await paginas()) {
      const { container } = render(pagina);
      for (const peca of ["pagina", "cartao", "titulo", "texto"]) {
        expect(container.querySelector(`[data-rd-sistema="${peca}"]`), peca).not.toBeNull();
      }
      cleanup();
    }
  });

  it("ligada: o erro de segmento marca o ID e as ações dentro do provedor", () => {
    const { container } = render(
      <ProvedorDoRedesign ligado>
        <SegmentError error={new Error("x")} reset={() => {}} />
      </ProvedorDoRedesign>,
    );
    for (const peca of ["pagina", "cartao", "titulo", "erro-id", "acoes"]) {
      expect(container.querySelector(`[data-rd-sistema="${peca}"]`), peca).not.toBeNull();
    }
  });
});

const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const INICIO = "/* redesign: sistema ───────────────────────────────";
const FIM = "/* redesign: sistema — fim ─────────────────────── */";
const ESCOPO = '[data-redesign="ligado"]';

function bloco(css: string): string {
  const i = css.indexOf(INICIO);
  const f = css.indexOf(FIM);
  if (i < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
  return css.slice(i, f);
}

function partes(seletor: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let atual = "";
  for (const ch of seletor) {
    if (ch === "(" || ch === "[") nivel++;
    if (ch === ")" || ch === "]") nivel--;
    if (ch === "," && nivel === 0) {
      out.push(atual);
      atual = "";
    } else atual += ch;
  }
  out.push(atual);
  return out.map((s) => s.replace(/\s+/g, " ").trim());
}

function violacoes(css: string): { regras: number; erros: string[] } {
  const erros: string[] = [];
  let regras = 0;
  const raiz = postcss.parse(css);
  raiz.walkAtRules((at) => {
    if (at.name !== "media") erros.push(`@${at.name} não é permitido`);
  });
  raiz.walkRules((r) => {
    regras++;
    for (const p of partes(r.selector)) if (!p.startsWith(ESCOPO)) erros.push(p);
  });
  return { regras, erros };
}

describe("redesign: sistema — CSS", () => {
  it('todo seletor do bloco começa por [data-redesign="ligado"]', () => {
    const r = violacoes(bloco(CSS));
    expect(r.regras).toBeGreaterThan(10);
    expect(r.erros).toEqual([]);
  });

  it("controle negativo: a régua reprova seletor sem escopo", () => {
    const r = violacoes('[data-rd-sistema="cartao"] { color: red }\n[data-redesign="ligado"] a, b { x: y }');
    expect(r.erros).toEqual(['[data-rd-sistema="cartao"]', "b"]);
  });
});
