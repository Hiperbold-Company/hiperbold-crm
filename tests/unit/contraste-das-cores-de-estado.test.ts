/**
 * Contraste MEDIDO, nos dois temas, dos pares de cor que a troca para tokens
 * de 17/11/2026 criou. O número sai de `app/globals.css` (o valor que o
 * navegador pinta), nunca desta prosa:
 *
 * - texto de estado (`text-<estado>-fg`) sobre a faixa de estado, que é
 *   `bg-surface` com o tom translúcido (`bg-<estado>-bg`) por cima;
 * - os contadores vermelhos do menu (`bg-error-fg` + `text-surface`);
 * - o botão dos avisos do topo (`text-<estado>-fg` sobre `bg-surface`);
 * - as bolinhas "quem atende" (`bg-ia`, `bg-info`, `bg-warning`) contra a
 *   superfície — elemento gráfico, piso de 3:1 (WCAG 1.4.11).
 *
 * Texto pequeno: piso de 4,5:1 (WCAG 1.4.3).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CSS = fs.readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

function bloco(seletor: string): string {
  const i = CSS.indexOf(`${seletor} {`);
  if (i < 0) throw new Error(`bloco ${seletor} não encontrado`);
  return CSS.slice(i, CSS.indexOf("\n}", i));
}

type Rgba = [number, number, number, number];

function cor(tema: string, nome: string): Rgba {
  const m = bloco(tema).match(new RegExp(`--color-${nome}:\\s*([^;]+);`));
  if (!m) throw new Error(`--color-${nome} ausente em ${tema}`);
  const v = m[1].trim();
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = v.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3], +rgba[4]];
  throw new Error(`--color-${nome} em ${tema} não é hex nem rgba: ${v}`);
}

/** Cor translúcida pintada sobre um fundo opaco. */
function sobre([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba {
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
}

function luminancia([r, g, b]: Rgba): number {
  const c = [r, g, b].map((x) => {
    const s = x / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contraste(a: Rgba, b: Rgba): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function matiz([r, g, b]: Rgba): number {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  if (d === 0) return 0;
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return (h * 60 + 360) % 360;
}

const TEMAS = [
  { nome: "claro", seletor: ":root" },
  { nome: "escuro", seletor: '[data-theme="dark"]' },
] as const;
const ESTADOS = ["success", "warning", "error", "info"] as const;

describe.each(TEMAS)("contraste no tema $nome", ({ seletor }) => {
  const superficie = cor(seletor, "surface");

  it.each(ESTADOS)("texto de %s sobre a faixa de estado ≥ 4,5:1", (estado) => {
    const faixa = sobre(cor(seletor, `${estado}-bg`), superficie);
    expect(contraste(cor(seletor, `${estado}-fg`), faixa)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ESTADOS)("botão do aviso (%s-fg sobre a superfície) ≥ 4,5:1", (estado) => {
    expect(contraste(cor(seletor, `${estado}-fg`), superficie)).toBeGreaterThanOrEqual(4.5);
  });

  it("contadores vermelhos do menu (text-surface sobre bg-error-fg) ≥ 4,5:1", () => {
    expect(contraste(superficie, cor(seletor, "error-fg"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["ia", "info", "warning"])("bolinha bg-%s contra a superfície ≥ 3:1", (nome) => {
    expect(contraste(cor(seletor, nome), superficie)).toBeGreaterThanOrEqual(3);
  });

  it("a bolinha da IA não se confunde com a de humano nem com a de aguardando", () => {
    // Matiz, não distância RGB: as três têm luminosidade parecida de propósito,
    // e o que separa uma da outra a olho é a cor (roxo × azul × âmbar).
    const ia = matiz(cor(seletor, "ia"));
    for (const outra of ["info", "warning"]) {
      const o = matiz(cor(seletor, outra));
      const d = Math.min(Math.abs(ia - o), 360 - Math.abs(ia - o));
      expect(d, `ia × ${outra}: ${d.toFixed(0)}°`).toBeGreaterThanOrEqual(40);
    }
  });
});

describe("os contadores do menu usam o par medido acima", () => {
  it.each([
    "components/shell/ContadorDaFila.tsx",
    "components/shell/ContadorDeCasos.tsx",
    "components/shell/ContadorDeTarefas.tsx",
    "components/shell/AlertsBell.tsx",
  ])("%s", (f) => {
    const fonte = fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");
    expect(fonte).toMatch(/bg-error-fg[^"`]*text-surface/);
    expect(fonte).not.toMatch(/bg-(error|destructive)\b[^"`]*text-(white|destructive-foreground)/);
  });
});
