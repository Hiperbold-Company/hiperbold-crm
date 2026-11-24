/**
 * OS NÓS DO EDITOR NO REDESIGN — desligado é o cartão de sempre, ligado é o "Se / Então".
 *
 * `NodeCard` (usado por todo tipo de nó) ganha `data-rd-editor="<peça>"` SÓ com a
 * chave ligada (`useMarcaDoEditor`), e o bloco "redesign: editor" de
 * `app/globals.css` o desenha. Provado aqui:
 *
 *   1. DOM — sem o provedor nenhum atributo é escrito; com ele, o papel do nó e
 *      as peças principais aparecem, e os textos e data-testid seguem iguais.
 *   2. CSS — todo seletor do bloco começa por `[data-redesign="ligado"]`.
 *
 * NÃO prova a aparência: jsdom não pinta; a semelhança com o protótipo v49 só se
 * confere na tela.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import postcss from "postcss";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/fluxos/editor/EtapasDoFluxo", () => ({
  useEtapasDoFluxo: () => ({ etapas: [], carregando: false, falhou: false, nomes: {} }),
}));
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));

import { NodeCard } from "@/components/fluxos/editor/nodes/NodeCard";
import { NODE_VISUALS } from "@/components/fluxos/editor/nodes/nodeVisuals";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import { marcaDoEditor, pecaDoNo } from "@/lib/redesign/editor";

function ligado({ children }: { children: ReactNode }) {
  return <ProvedorDoRedesign ligado>{children}</ProvedorDoRedesign>;
}

const no = (tipo: keyof typeof NODE_VISUALS, extra: Partial<Parameters<typeof NodeCard>[0]> = {}) => (
  <NodeCard id="n1" visual={NODE_VISUALS[tipo]} label="Título do nó" subtitle="Resumo da configuração" {...extra} />
);

afterEach(cleanup);

describe("redesign: editor, DOM", () => {
  it("desligado, nenhum tipo de nó escreve data-rd-editor", () => {
    for (const tipo of ["trigger", "condition", "action", "wait", "end"] as const) {
      const { container } = render(no(tipo, { errors: ["x"] }));
      expect(container.querySelectorAll("[data-rd-editor]")).toHaveLength(0);
      cleanup();
    }
  });

  it("ligado, cada tipo marca o seu papel e as peças do cartão", () => {
    const papeis = { trigger: "no-quando", condition: "no-se", action: "no-entao", wait: "no-espera", end: "no-fim" } as const;
    for (const [tipo, papel] of Object.entries(papeis)) {
      const { container } = render(no(tipo as keyof typeof NODE_VISUALS, { errors: ["falta algo"] }), { wrapper: ligado });
      const pecas = Array.from(container.querySelectorAll("[data-rd-editor]")).map((e) => e.getAttribute("data-rd-editor"));
      for (const p of [papel, "icone", "titulo", "resumo", "erro"]) expect(pecas).toContain(p);
      expect(screen.getByTestId("node-card-n1").getAttribute("data-rd-editor")).toBe(papel);
      cleanup();
    }
  });

  it("ligado, o texto e os ids de teste seguem os mesmos", () => {
    render(no("condition"), { wrapper: ligado });
    expect(screen.getByText("Título do nó")).toBeTruthy();
    expect(screen.getByText("Resumo da configuração")).toBeTruthy();
  });

  // Onda 4 (v49): o único acréscimo ligado é o rótulo do papel em cima do título
  // — Quando (gatilho), Se (decisão), Então (ação). Espera e fim não têm rótulo
  // no protótipo. Fora esse rótulo, o texto e os ids de teste são os de sempre.
  it("ligado, só o rótulo do papel se acrescenta ao texto", () => {
    const papeis = { trigger: "Quando", condition: "Se", action: "Então", wait: null, end: null } as const;
    for (const [tipo, rotulo] of Object.entries(papeis)) {
      const off = render(no(tipo as keyof typeof NODE_VISUALS, { errors: ["falta algo"] }));
      const textoOff = off.container.textContent;
      const idsOff = Array.from(off.container.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid"));
      cleanup();
      const on = render(no(tipo as keyof typeof NODE_VISUALS, { errors: ["falta algo"] }), { wrapper: ligado });
      const papel = on.container.querySelector('[data-rd-editor="papel"]');
      expect(papel?.textContent ?? null, tipo).toBe(rotulo);
      papel?.remove();
      expect(on.container.textContent, tipo).toBe(textoOff);
      expect(Array.from(on.container.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid")), tipo).toEqual(idsOff);
      cleanup();
    }
  });

  it("marcaDoEditor e pecaDoNo: ligada devolve a peça, desligada undefined", () => {
    expect(marcaDoEditor(true)("canvas")).toBe("canvas");
    expect(marcaDoEditor(false)("canvas")).toBeUndefined();
    expect(pecaDoNo("trigger")).toBe("no-quando");
    expect(pecaDoNo("ai_classify")).toBe("no-se");
    expect(pecaDoNo("message")).toBe("no-entao");
  });
});

describe("redesign: editor, CSS escopado pela chave", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: editor ";
  const FIM = "/* redesign: editor — fim";
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
    expect(r.regras).toBeGreaterThan(10);
    expect(r.erros).toEqual([]);
  });

  it("controle negativo: a régua reprova seletor sem escopo", () => {
    const r = erros(`.x { color: red; } ${ESCOPO} .a, .b { color: red; }`);
    expect(r.erros).toContain("seletor sem escopo: .x");
    expect(r.erros).toContain("seletor sem escopo: .b");
  });
});
