/**
 * Bloco "Sorteio" (`random_split`): contrato do schema, as saídas A e B, a
 * decisão do motor com a fonte de aleatoriedade injetada, a distribuição da
 * fonte REAL e a ida e volta pelo arquivo de exportação.
 */
import { describe, expect, it } from "vitest";

import {
  flowGraphSchema,
  nodeBranches,
  SORTEIO_A_BRANCH_ID,
  SORTEIO_B_BRANCH_ID,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "@/lib/followup/graph-schema";
import { ladoDoSorteio, processNode, sorteioSeguro, type EnrollmentRow } from "@/lib/followup/node-handlers";
import { NOS_DA_SUPERFICIE, REGISTRO_DE_NOS } from "@/lib/followup/registro-de-nos";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import {
  exportarAutomacao,
  lerArquivoDeAutomacao,
  montarGrafoImportado,
  previaDaImportacao,
} from "./portabilidade";
import { sorteioConfigSchema } from "./schemas";

const AGORA = new Date("2026-11-14T12:00:00Z");
const pos = { x: 0, y: 0 };
const sempre = { type: "always" } as const;

function no(percent_a: number): Extract<FlowNode, { type: "random_split" }> {
  return { id: "s1", type: "random_split", label: "Sorteio", position: pos, config: { percent_a } };
}
const aresta = (id: string, target: string, ramo: "a" | "b", priority = 0): FlowEdge => ({
  id,
  source: "s1",
  target,
  priority,
  condition: { type: "branch", branch_id: ramo },
});

const enrollment = { id: "e1", organization_id: "o1", lane: "automacao" } as EnrollmentRow;
const lead = { lead_stage: null, tags: [], steps_taken: 0, last_outcome: null };

function decidir(percentA: number, sorteado: number, edges: FlowEdge[]) {
  return processNode({
    node: no(percentA),
    edges,
    enrollment,
    lead,
    clock: () => AGORA,
    sortear: () => sorteado,
  });
}

describe("schema do sorteio", () => {
  it("aceita de 1 a 99 e recusa o resto", () => {
    for (const v of [1, 50, 99]) expect(sorteioConfigSchema.safeParse({ percent_a: v }).success, String(v)).toBe(true);
    for (const v of [0, 100, -5, 50.5, Number.NaN, "50"]) {
      expect(sorteioConfigSchema.safeParse({ percent_a: v }).success, String(v)).toBe(false);
    }
    expect(sorteioConfigSchema.safeParse({}).success).toBe(false);
    expect(sorteioConfigSchema.safeParse({ percent_a: 50, extra: 1 }).success).toBe(false);
  });

  it("o nó entra no grafo, só na superfície de automação, e é decisão (não efeito)", () => {
    expect(grafo(true).nodes.some((n) => n.type === "random_split")).toBe(true);
    expect(NOS_DA_SUPERFICIE.automacao).toContain("random_split");
    expect(NOS_DA_SUPERFICIE.followup).not.toContain("random_split");
    expect(NOS_DA_SUPERFICIE.atendimento).not.toContain("random_split");
    expect(REGISTRO_DE_NOS.random_split.efeito).toBe(false);
  });

  it("duas saídas com ids estáveis e o percentual no rótulo", () => {
    expect(nodeBranches(no(50)).map((r) => [r.id, r.label])).toEqual([
      ["a", "A (50%)"],
      ["b", "B (50%)"],
    ]);
    expect(nodeBranches(no(30)).map((r) => r.label)).toEqual(["A (30%)", "B (70%)"]);
    expect(nodeBranches(no(30)).map((r) => r.condition)).toEqual([
      { type: "branch", branch_id: SORTEIO_A_BRANCH_ID },
      { type: "branch", branch_id: SORTEIO_B_BRANCH_ID },
    ]);
  });
});

describe("decisão do sorteio (fonte injetada)", () => {
  const edges = [aresta("e1", "x", "a"), aresta("e2", "y", "b")];

  it("abaixo do corte vai para A; no corte e acima, para B", () => {
    expect(decidir(50, 0, edges)).toMatchObject({ kind: "advance", next_node_id: "x", branch: "a" });
    expect(decidir(50, 0.4999, edges)).toMatchObject({ kind: "advance", next_node_id: "x", branch: "a" });
    expect(decidir(50, 0.5, edges)).toMatchObject({ kind: "advance", next_node_id: "y", branch: "b" });
    expect(decidir(50, 0.9999, edges)).toMatchObject({ kind: "advance", next_node_id: "y", branch: "b" });
    expect(decidir(10, 0.09, edges)).toMatchObject({ next_node_id: "x" });
    expect(decidir(10, 0.1, edges)).toMatchObject({ next_node_id: "y" });
    expect(decidir(99, 0.98, edges)).toMatchObject({ next_node_id: "x" });
  });

  it("o desfecho NÃO vai em `class` (não vira o 'último desfecho' das condições)", () => {
    const r = decidir(50, 0.1, edges);
    expect(r).not.toHaveProperty("class");
  });

  it("lado sem aresta ligada encerra a execução, nunca cai no outro lado", () => {
    expect(decidir(50, 0.1, [aresta("e2", "y", "b")])).toEqual({ kind: "complete", outcome: null });
    expect(decidir(50, 0.9, [aresta("e1", "x", "a")])).toEqual({ kind: "complete", outcome: null });
    // Uma aresta `always` solta também não serve de escape.
    const solta: FlowEdge = { id: "e3", source: "s1", target: "z", priority: 0, condition: sempre };
    expect(decidir(50, 0.1, [solta])).toEqual({ kind: "complete", outcome: null });
  });

  it("ladoDoSorteio é a regra do corte", () => {
    expect(ladoDoSorteio(1, 0.0099)).toBe("a");
    expect(ladoDoSorteio(1, 0.01)).toBe("b");
  });
});

describe("a fonte de aleatoriedade real", () => {
  it.each([50, 20, 80])("10.000 sorteios com %i%% em A ficam a ±2 pontos", (percentA) => {
    const edges = [aresta("e1", "x", "a"), aresta("e2", "y", "b")];
    let emA = 0;
    const total = 10_000;
    for (let i = 0; i < total; i++) {
      const r = processNode({ node: no(percentA), edges, enrollment, lead, clock: () => AGORA });
      if (r.kind === "advance" && r.next_node_id === "x") emA++;
    }
    expect(Math.abs((emA / total) * 100 - percentA)).toBeLessThanOrEqual(2);
  });

  it("devolve números em [0, 1) e não repete sempre o mesmo", () => {
    const vistos = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const n = sorteioSeguro();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
      vistos.add(n);
    }
    expect(vistos.size).toBeGreaterThan(150);
  });
});

function grafo(ligarB: boolean): FlowGraph {
  return flowGraphSchema.parse({
    nodes: [
      {
        id: "n1",
        type: "trigger",
        label: "Início",
        position: pos,
        config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
      },
      no(30),
      { id: "f1", type: "end", label: "Fim A", position: pos, config: { outcome: "converted" } },
      { id: "f2", type: "end", label: "Fim B", position: pos, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e0", source: "n1", target: "s1", priority: 0, condition: sempre },
      aresta("e1", "f1", "a"),
      ...(ligarB ? [aresta("e2", "f2", "b")] : []),
    ],
  });
}

describe("publicação", () => {
  it("com as duas saídas ligadas publica", () => {
    expect(validateFlowForPublish(grafo(true), { surface: "automacao" })).toEqual({ ok: true });
  });

  it("saída sem ligação é recusada, nomeando qual", () => {
    const r = validateFlowForPublish(grafo(false), { surface: "automacao" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContainEqual(
      expect.objectContaining({ node_id: "s1", code: "missing_branch_edge", branch_id: "b" }),
    );
    expect(r.errors.find((e) => e.branch_id === "b")?.message).toContain("B (70%)");
  });

  it("não publica num follow-up", () => {
    const r = validateFlowForPublish(grafo(true), { surface: "followup" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("no_fora_da_superficie");
  });
});

describe("exportar e importar por arquivo", () => {
  it("o bloco volta igual, com o percentual e as duas saídas", () => {
    const arquivo = exportarAutomacao(
      { id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "Teste A/B", grafo: grafo(true) },
      [],
      AGORA,
    );
    const leitura = lerArquivoDeAutomacao(JSON.parse(JSON.stringify(arquivo)));
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    const previa = previaDaImportacao(leitura.arquivo, leitura.usadas, []);
    expect(previa.caixas).toBe(4);
    const m = montarGrafoImportado(leitura.arquivo, leitura.usadas, {}, [], "bbbbbbbb-0000-4000-8000-000000000001");
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.grafo).toEqual(grafo(true));
    const sorteio = m.grafo.nodes.find((n) => n.type === "random_split");
    expect(sorteio?.config).toEqual({ percent_a: 30 });
    expect(m.grafo.edges.filter((e) => e.source === "s1").map((e) => e.condition)).toEqual([
      { type: "branch", branch_id: "a" },
      { type: "branch", branch_id: "b" },
    ]);
  });

  it("percentual fora de 1 a 99 no arquivo é recusado", () => {
    const arquivo = exportarAutomacao(
      { id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "x", grafo: grafo(true) },
      [],
      AGORA,
    );
    const adulterado = JSON.parse(JSON.stringify(arquivo)) as {
      automacao: { grafo: { nodes: Array<{ type: string; config: { percent_a?: number } }> } };
    };
    adulterado.automacao.grafo.nodes.find((n) => n.type === "random_split")!.config.percent_a = 100;
    expect(lerArquivoDeAutomacao(adulterado).ok).toBe(false);
  });
});
