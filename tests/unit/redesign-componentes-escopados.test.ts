/**
 * O redesign dos componentes base não pode vazar para quem está com a chave
 * desligada.
 *
 * As regras moram em `app/globals.css`, entre `/* redesign: componentes *\/` e
 * `/* redesign: componentes — fim *\/`, FORA de `@layer` (para vencer os
 * utilitários do próprio componente). Fora de camada, uma regra sem escopo
 * venceria qualquer classe de qualquer tela — então TODO seletor do bloco tem
 * de começar por `[data-redesign="ligado"]`, que o layout raiz só escreve no
 * `<html>` com a chave ligada.
 *
 * Mede o bloco de verdade (postcss), desce em `@media`, separa listas por
 * vírgula e recusa `@keyframes` (nome de animação é global, não tem escopo).
 * O controle negativo prova que a régua reprova o que deve reprovar.
 */
import fs from "node:fs";
import path from "node:path";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";

const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
const INICIO = "/* redesign: componentes */";
const FIM = "/* redesign: componentes — fim */";
const ESCOPO = '[data-redesign="ligado"]';

function extrairBloco(css: string): string {
  const i = css.indexOf(INICIO);
  const f = css.indexOf(FIM);
  if (i < 0 || f < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
  if (css.indexOf(INICIO, i + 1) >= 0) throw new Error("marcador de início repetido");
  return css.slice(i + INICIO.length, f);
}

/** Separa uma lista de seletores pelas vírgulas de NÍVEL ZERO (fora de `:is()`). */
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

function violacoes(bloco: string): { regras: number; erros: string[] } {
  const raiz: Root = postcss.parse(bloco);
  const erros: string[] = [];
  let regras = 0;
  raiz.walkAtRules((at) => {
    if (at.name !== "media") erros.push(`@${at.name} ${at.params} não é permitido no bloco`);
  });
  raiz.walkRules((regra) => {
    regras++;
    for (const p of partes(regra.selector)) {
      if (!p.startsWith(ESCOPO)) erros.push(`seletor sem escopo: ${p}`);
    }
  });
  raiz.walkDecls((d) => {
    if (d.important) erros.push(`!important em ${d.prop}`);
  });
  return { regras, erros };
}

describe("redesign: componentes base escopados pela chave", () => {
  it("o bloco existe e tem regras", () => {
    expect(violacoes(extrairBloco(CSS)).regras).toBeGreaterThan(20);
  });

  it('todo seletor do bloco começa por [data-redesign="ligado"]', () => {
    expect(violacoes(extrairBloco(CSS)).erros).toEqual([]);
  });

  it("cartão 20px e botão de ícone 34px existem, escopados e respeitando p-0", () => {
    const bloco = extrairBloco(CSS);
    expect(bloco).toContain('[data-slot="card-header"][class~="p-6"]:not([class*="p-0"]');
    expect(bloco).toMatch(/\[data-slot="card-content"\], \[data-slot="card-footer"\]/);
    expect(bloco).toContain('[data-slot="button"][data-size="icon"][class~="lg:h-9"]');
    expect(bloco).toMatch(/padding: 20px;/);
    expect(bloco).toMatch(/width: 34px;/);
  });

  it("controle negativo: a régua reprova seletor sem escopo, lista mista e @keyframes", () => {
    const ruim = `
      .x { color: red; }
      ${ESCOPO} .a, .b { color: red; }
      @media (width >= 64rem) { [data-slot="button"] { height: 38px; } }
      @keyframes pulo { from { opacity: 0; } to { opacity: 1; } }
      ${ESCOPO} :is(.c, .d) { color: blue; }
    `;
    const { erros } = violacoes(ruim);
    expect(erros).toContain("seletor sem escopo: .x");
    expect(erros).toContain("seletor sem escopo: .b");
    expect(erros).toContain('seletor sem escopo: [data-slot="button"]');
    expect(erros.some((e) => e.startsWith("@keyframes"))).toBe(true);
    // vírgula DENTRO de :is() não separa seletor: este caso é válido
    expect(erros.some((e) => e.includes(":is(.c"))).toBe(false);
  });
});
