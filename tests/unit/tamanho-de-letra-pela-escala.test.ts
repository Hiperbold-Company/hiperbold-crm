import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Tamanho de letra só pela escala do `@theme` (`text-2xs`, `text-xs`, `text-sm`…).
 * `text-[11px]` e parentes são degrau fora da escala: a tela ganha um tamanho
 * que o design system não conhece.
 */

const RAIZ = process.cwd();

/**
 * Arquivos que ainda carregam `text-[Npx]` porque pertencem a outra branch de
 * trabalho. A lista SÓ PODE ENCOLHER: quando a outra branch entrar, o arquivo
 * sai daqui (o teste reprova entrada que já está limpa).
 */
const PENDENTES_DE_OUTRA_BRANCH = [
  "app/app/metrics/_components/AbaNegocios.tsx",
  "components/inbox/InboxFilters.tsx",
  "components/shell/PaletaDeDestinos.tsx",
];

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

const TAMANHO_ARBITRARIO = /text-\[\d+(\.\d+)?(px|rem)\]/;

describe("tamanho de letra pela escala", () => {
  const arquivos = [...tsx("app"), ...tsx("components")];

  it("nenhum .tsx usa `text-[<n>px]` nem `text-[<n>rem]`", () => {
    const sujos = arquivos.filter(
      (f) =>
        !PENDENTES_DE_OUTRA_BRANCH.includes(f) &&
        TAMANHO_ARBITRARIO.test(fs.readFileSync(path.join(RAIZ, f), "utf8")),
    );
    expect(sujos, "use text-2xs / text-xs / text-sm / text-base / text-lg").toEqual([]);
  });

  it("a allowlist só encolhe: entrada limpa tem de sair", () => {
    const limpos = PENDENTES_DE_OUTRA_BRANCH.filter(
      (f) => !TAMANHO_ARBITRARIO.test(fs.readFileSync(path.join(RAIZ, f), "utf8")),
    );
    expect(limpos).toEqual([]);
  });
});
