import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NODE_VISUALS } from "@/components/fluxos/editor/nodes/nodeVisuals";

/**
 * Toda caixa que a paleta oferece (`NODE_VISUALS`) precisa de um componente no
 * mapa `nodeTypes` do editor. Sem a linha, o React Flow desenha a caixa
 * desconhecida, sem estilo e sem as linhas. Já aconteceu três vezes: #1540,
 * #2065 e os blocos do Instagram (10/11/2026).
 */
describe("editor de fluxo: toda caixa da paleta está registrada", () => {
  const fonte = readFileSync(join(process.cwd(), "components/fluxos/editor/FlowCanvas.tsx"), "utf8");
  const inicio = fonte.indexOf("const nodeTypes: NodeTypes = {");
  const mapa = fonte.slice(inicio, fonte.indexOf("\n};", inicio));
  const registrados = new Set([...mapa.matchAll(/^\s{2}([a-z_]+):\s/gm)].map((m) => m[1]));

  it("o mapa foi lido", () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(registrados.size).toBeGreaterThan(10);
  });

  it.each(Object.keys(NODE_VISUALS))("%s tem componente no nodeTypes", (tipo) => {
    expect(registrados.has(tipo)).toBe(true);
  });
});
