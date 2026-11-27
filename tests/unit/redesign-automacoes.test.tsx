/**
 * A ÁREA AUTOMAÇÕES NO REDESIGN — desligado é a tela de sempre, ligado é a nova.
 *
 * Os componentes não foram duplicados: ganham `data-rd-automacoes="<peça>"` SÓ
 * com a chave ligada (`useMarcaDasAutomacoes`), e o bloco "redesign: automacoes"
 * de `app/globals.css` os desenha. As duas metades de "desligado não muda nada":
 *
 *   1. DOM — sem o provedor do redesign nenhum atributo do redesign é escrito;
 *      com ele, as peças principais aparecem.
 *   2. CSS — todo seletor do bloco começa por `[data-redesign="ligado"]`, que o
 *      `<html>` só tem com a chave ligada.
 *
 * Não prova a aparência: jsdom não pinta. A semelhança com o protótipo v49 só
 * se confere na tela.
 */
import fs from "node:fs";
import path from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import postcss from "postcss";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/automacoes",
  useSearchParams: () => new URLSearchParams(""),
}));

import { AutomacoesList } from "@/app/app/automacoes/_components/AutomacoesList";
import { ExecucoesDeIa } from "@/app/app/ai/runs/_components/ExecucoesDeIa";
import { NodePalette } from "@/components/fluxos/editor/NodePalette";
import { marcaDasAutomacoes } from "@/lib/redesign/automacoes";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

const ATRIBUTOS = "[data-rd-automacoes],[data-rd-estado]";

function Envoltorio({ ligado, children }: { ligado: boolean; children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const conteudo = <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return ligado ? <ProvedorDoRedesign ligado>{conteudo}</ProvedorDoRedesign> : conteudo;
}

const AUTOMACAO = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Novo lead do Facebook",
  status: "active",
  active_version_id: "v1",
  handoff_policy: "pause",
  updated_at: "2026-11-18T12:00:00Z",
};

function lista(ligado: boolean) {
  return render(
    <Envoltorio ligado={ligado}>
      <AutomacoesList
        initialData={[AUTOMACAO] as never}
        followups={[{ id: "f1", name: "Reengajar", status: "draft", surface: "followup", updated_at: "2026-11-17T12:00:00Z" }] as never}
        regras={[]}
      />
    </Envoltorio>,
  );
}

describe("Automações no redesign — a lista", () => {
  it("desligado: nenhum atributo do redesign (a lista de sempre)", () => {
    const { container } = lista(false);
    expect(container.querySelectorAll(ATRIBUTOS)).toHaveLength(0);
    expect(screen.getByTestId("lista-de-automacoes")).toBeInTheDocument();
    expect(screen.getByTestId("nova-automacao")).toBeInTheDocument();
  });

  it("ligado: barra, busca, filtros, grade, cartão, estado e rodapé aparecem", () => {
    const { container } = lista(true);
    for (const peca of ["barra", "busca", "filtros", "grade", "cartao", "cartao-corpo", "cartao-nome", "cartao-tipo", "cartao-rodape", "estado"]) {
      expect(container.querySelector(`[data-rd-automacoes="${peca}"]`), peca).not.toBeNull();
    }
    expect(container.querySelector('[data-rd-estado="active"]')).not.toBeNull();
    // a tela é a mesma: ids de teste e textos intactos
    expect(screen.getByTestId("lista-de-automacoes")).toBeInTheDocument();
    expect(screen.getByText("Novo lead do Facebook")).toBeInTheDocument();
  });

  it("o DOM ligado só difere do desligado pelos atributos do redesign", () => {
    const off = lista(false).container.innerHTML;
    const on = lista(true).container.innerHTML;
    const semAtributos = on.replace(/ data-rd-(automacoes|estado)="[^"]*"/g, "");
    expect(semAtributos).toBe(off);
  });
});

describe("Automações no redesign — a paleta do editor", () => {
  it("desligado: sem atributo; ligado: a paleta é marcada", () => {
    const off = render(
      <Envoltorio ligado={false}>
        <NodePalette onAdd={() => {}} surface="automacao" />
      </Envoltorio>,
    );
    expect(off.container.querySelectorAll(ATRIBUTOS)).toHaveLength(0);
    off.unmount();
    const on = render(
      <Envoltorio ligado>
        <NodePalette onAdd={() => {}} surface="automacao" />
      </Envoltorio>,
    );
    expect(on.container.querySelector('[data-rd-automacoes="paleta"]')).not.toBeNull();
  });
});

describe("Automações no redesign — Execuções de IA", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { execucoes: [], resumo: { total: 0, erros: 0, porCodigo: [] } } }), {
            status: 200,
          }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("desligado: nenhum atributo", async () => {
    const { container } = render(<ExecucoesDeIa />);
    await screen.findByTestId("resumo");
    expect(container.querySelectorAll(ATRIBUTOS)).toHaveLength(0);
  });

  it("ligado: página, cabeçalho, abas, resumo, barra e vazio aparecem", async () => {
    const { container } = render(
      <ProvedorDoRedesign ligado>
        <ExecucoesDeIa />
      </ProvedorDoRedesign>,
    );
    await screen.findByTestId("resumo");
    for (const peca of ["pagina", "cabecalho", "titulo", "abas", "descricao", "resumo", "barra", "vazio"]) {
      expect(container.querySelector(`[data-rd-automacoes="${peca}"]`), peca).not.toBeNull();
    }
  });
});

describe("marcaDasAutomacoes (a regra pura, usada nas páginas de servidor)", () => {
  it("desligada devolve undefined; ligada devolve a própria peça", () => {
    expect(marcaDasAutomacoes(false)("grade")).toBeUndefined();
    expect(marcaDasAutomacoes(true)("grade")).toBe("grade");
  });
});

describe("CSS do redesign das Automações: escopado pela chave", () => {
  const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: automacoes";
  const FIM = "/* redesign: automacoes — fim";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
    if (css.indexOf(INICIO, i + 1) !== f) throw new Error("marcador de início repetido");
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

  function erros(css: string): string[] {
    const e: string[] = [];
    const raiz = postcss.parse(css);
    raiz.walkAtRules((at) => {
      if (at.name !== "media") e.push(`@${at.name} ${at.params} não é permitido no bloco`);
    });
    raiz.walkRules((r) => {
      for (const p of partes(r.selector)) if (!p.startsWith(ESCOPO)) e.push(`seletor sem escopo: ${p}`);
    });
    raiz.walkDecls((d) => {
      if (d.important) e.push(`!important em ${d.prop}`);
    });
    return e;
  }

  it("o bloco existe e tem regras", () => {
    let regras = 0;
    postcss.parse(bloco(CSS)).walkRules(() => {
      regras++;
    });
    expect(regras).toBeGreaterThan(20);
  });

  it('todo seletor do bloco começa por [data-redesign="ligado"]', () => {
    expect(erros(bloco(CSS))).toEqual([]);
  });

  it("controle negativo: a régua reprova seletor sem escopo", () => {
    expect(erros(`.x { color: red; } ${ESCOPO} .a, .b { color: red; }`)).toEqual([
      "seletor sem escopo: .x",
      "seletor sem escopo: .b",
    ]);
  });
});
