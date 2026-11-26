import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A empresa é cobrada em TOKENS de IA, não em dólar. Estas telas de uso da
 * empresa não podem formatar custo de IA em dólar (o painel /admin pode).
 */
const TELAS = [
  "app/app/ai/agents/[id]/_components/RunsTable.tsx",
  "app/app/ai/agents/[id]/_components/RunDetailDrawer.tsx",
  "app/app/ai/agents/[id]/_components/TestPanel.tsx",
  "app/app/ai/runs/_components/ExecucoesDeIa.tsx",
  "app/app/ai/providers/_components/CartaoDoJev.tsx",
  "app/app/ai/evolution/_client.tsx",
];

describe("telas de IA da empresa não mostram dólar", () => {
  for (const arquivo of TELAS) {
    it(arquivo, () => {
      const src = readFileSync(arquivo, "utf8");
      // Só código e texto de tela: comentários ficam de fora.
      const semComentarios = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(semComentarios).not.toMatch(/US\$/);
      expect(semComentarios).not.toMatch(/formatCentsUSD/);
      expect(semComentarios).not.toMatch(/currency:\s*"USD"/);
      expect(semComentarios).not.toMatch(/\.cost_cents|\bn\.custo_cents/);
    });
  }
});
