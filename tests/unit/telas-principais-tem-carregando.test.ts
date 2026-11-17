import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Toda tela principal tem esqueleto de carregamento (`loading.tsx`) e ele não
 * usa spinner solto nem o texto "Carregando": o padrão é Skeleton no formato
 * da tela, como em inbox/kanban/contacts.
 */
const RAIZ = process.cwd();
const ROTAS = ["inbox", "kanban", "contacts", "automacoes", "metrics", "connections", "settings", "pipelines/[id]"];

describe("telas principais: carregando", () => {
  for (const rota of ROTAS) {
    const arquivo = path.join(RAIZ, "app/app", rota, "loading.tsx");

    it(`${rota} tem loading.tsx`, () => {
      expect(fs.existsSync(arquivo)).toBe(true);
    });

    it(`${rota} usa Skeleton, sem spinner nem texto`, () => {
      const fonte = fs.readFileSync(arquivo, "utf8");
      expect(fonte).toContain("Skeleton");
      expect(fonte).not.toContain("animate-spin");
      expect(fonte).not.toContain("Carregando");
    });
  }
});
