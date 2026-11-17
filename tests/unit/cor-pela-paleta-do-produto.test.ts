import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Cor só pelos tokens do produto (`bg-warning-bg`, `text-error-fg`,
 * `border-success/30`, `neutral-*`, `accent`). A paleta padrão do Tailwind
 * (`amber-500`, `red-600`…) é cor FIXA: não troca com o tema escuro nem com a
 * marca da instalação, e fura a régua de contraste de `lib/branding/contraste.ts`.
 */

const RAIZ = process.cwd();

/**
 * Arquivo → motivo, para cor que é DADO ou identidade (cor de etiqueta, de
 * conexão, de avatar, série de gráfico, marca de canal). SÓ PODE ENCOLHER:
 * entrada sem ocorrência reprova.
 */
const ALLOWLIST: Record<string, string> = {};

const FAMILIAS =
  "amber|yellow|orange|red|rose|emerald|green|lime|teal|sky|blue|cyan|indigo|gray|slate|zinc|stone|purple|violet|pink|fuchsia";
const PALETA = new RegExp(
  `(?<![\\w-])(?:[a-z0-9\\[\\]&>_-]+:)*(?:bg|text|border|border-[tblrxy]|ring|ring-offset|fill|stroke|divide|outline|from|to|via|decoration|shadow|accent|caret)-(?:${FAMILIAS})-\\d{2,3}(?![\\w-])`,
);

function tsx(dir: string, saida: string[] = []): string[] {
  const abs = path.join(RAIZ, dir);
  if (!fs.existsSync(abs)) return saida;
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) {
      if (d.name === "node_modules" || d.name.startsWith(".")) continue;
      if (rel === "app/design") continue;
      tsx(rel, saida);
    } else if (/\.tsx$/.test(d.name) && !/\.(test|spec)\.tsx$/.test(d.name)) {
      saida.push(rel);
    }
  }
  return saida;
}

const le = (f: string) => fs.readFileSync(path.join(RAIZ, f), "utf8");

describe("cor pela paleta do produto", () => {
  const arquivos = [...tsx("app"), ...tsx("components"), ...tsx("lib"), ...tsx("hooks")];

  it("nenhum .tsx usa a paleta padrão do Tailwind (família + número)", () => {
    const sujos = arquivos.filter((f) => !(f in ALLOWLIST) && PALETA.test(le(f)));
    expect(
      sujos,
      "troque por token: warning/error/success/info (-bg, -fg), neutral-N ou accent",
    ).toEqual([]);
  });

  it("a allowlist só encolhe e cada entrada tem motivo", () => {
    for (const [f, motivo] of Object.entries(ALLOWLIST)) {
      expect(motivo.length, `${f} sem motivo`).toBeGreaterThan(10);
      expect(PALETA.test(le(f)), `${f} já está limpo: tire da allowlist`).toBe(true);
    }
  });
});
