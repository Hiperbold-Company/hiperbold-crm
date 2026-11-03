/**
 * CERCA da raia (migration 0986): `followup_enrollments` passou a guardar DUAS
 * coisas — follow-ups (`lane='followup'`) e execuções de automação
 * (`lane='automacao'`). Todo leitor que pensa em "follow-up" tem de dizer a raia.
 *
 * O que já custou caro sem o filtro (revisão do lote 1):
 *   - o caminho de inbound avançava automações SEM executor de efeitos: o bloco
 *     saía pelo ramo Erro com `efeitos_indisponiveis`, para sempre;
 *   - o ceder-turno via uma automação numa espera como "follow-up vivo" e o
 *     agente respondia em dobro;
 *   - a fila, a lista e as estatísticas de follow-up contavam execuções de
 *     automação.
 *
 * A lista abaixo é dos leitores de follow-up. Leitor novo de `followup_enrollments`
 * que não for da raia de follow-up (o motor, o dossiê, as telas de automação)
 * NÃO entra aqui.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");

const LEITORES_DE_FOLLOWUP = [
  "lib/followup/aplicar-inbound.ts",
  "lib/dev/kick-local-pipeline.ts",
  "lib/followup/ceder-turno-ao-retorno.ts",
  "lib/followup/outcome-stats.ts",
  "app/api/v1/ai/followups/queue/route.ts",
  "app/api/v1/ai/followups/enrollments/route.ts",
];

/** Cada consulta de leitura: do `from` até o fim da instrução (`;`) ou do SQL (crase). */
function consultas(fonte: string): string[] {
  const out: string[] = [];
  const rx = /\.from\("followup_enrollments"\)|\bfrom followup_enrollments\b/g;
  for (const m of fonte.matchAll(rx)) {
    const inicio = m.index ?? 0;
    const resto = fonte.slice(inicio);
    const fim = m[0].startsWith(".from") ? resto.indexOf(";") : resto.indexOf("`");
    const trecho = resto.slice(0, fim < 0 ? 600 : fim);
    if (m[0].startsWith(".from") && !trecho.includes(".select(")) continue; // escrita
    out.push(trecho);
  }
  return out;
}

describe("leitores de follow-up dizem a raia (0986)", () => {
  it.each(LEITORES_DE_FOLLOWUP)("%s", (arquivo) => {
    // Comentário de linha fora: um `;` dentro dele cortaria a consulta no meio.
    const fonte = readFileSync(join(RAIZ, arquivo), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const lidas = consultas(fonte);
    expect(lidas.length, "nenhuma consulta encontrada: a cerca mediria o vazio").toBeGreaterThan(0);
    const semRaia = lidas.filter((q) => !/lane/.test(q)).map((q) => q.split("\n").slice(0, 3).join(" ").trim());
    expect(semRaia, "consulta de follow-up sem filtro de raia").toEqual([]);
  });
});
