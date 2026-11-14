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
import {
  ladoDoSorteio,
  processNode,
  saidaDoSorteio,
  sorteioSeguro,
  type EnrollmentRow,
} from "@/lib/followup/node-handlers";
import { NOS_DA_SUPERFICIE, REGISTRO_DE_NOS } from "@/lib/followup/registro-de-nos";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import {
  exportarAutomacao,
  lerArquivoDeAutomacao,
  montarGrafoImportado,
  previaDaImportacao,
} from "./portabilidade";
import {
  IDS_DOS_RAMOS_DO_SORTEIO,
  ramoSorteado,
  ramosDoSorteioConfig,
  rotuloDoRamoDoSorteio,
  sorteioConfigSchema,
  type SorteioConfig,
} from "./schemas";

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

// ---------------------------------------------------------------------------
// Sorteio PONDERADO: de 2 a 10 saídas, cada uma com o seu peso (soma 100)
// ---------------------------------------------------------------------------

/** 17 + 15 + 17 + 17 + 17 + 17 + 0 = 100: seis corretores e uma saída reservada (G). */
const PESOS_DA_ROLETA = [17, 15, 17, 17, 17, 17, 0];
const NOMES_DA_ROLETA = ["Kyla", "Bruno", "Ana", "Caio", "Davi", "Eva", "Reserva"];
const LETRAS = IDS_DOS_RAMOS_DO_SORTEIO.slice(0, PESOS_DA_ROLETA.length);

const ramosDaRoleta = () =>
  PESOS_DA_ROLETA.map((peso, i) => ({ peso, nome: NOMES_DA_ROLETA[i]! }));
const configDaRoleta = (): SorteioConfig => ({ ramos: ramosDaRoleta() });

function noPonderado(config: SorteioConfig = configDaRoleta()): Extract<FlowNode, { type: "random_split" }> {
  return { id: "s1", type: "random_split", label: "Sorteio", position: pos, config };
}
const arestaDoRamo = (ramo: string, target = `f-${ramo}`): FlowEdge => ({
  id: `e-${ramo}`,
  source: "s1",
  target,
  priority: 0,
  condition: { type: "branch", branch_id: ramo },
});

function grafoPonderado(sem: readonly string[] = [], config: SorteioConfig = configDaRoleta()): FlowGraph {
  const ramos = ramosDoSorteioConfig(config).map((r) => r.id);
  return flowGraphSchema.parse({
    nodes: [
      {
        id: "n1",
        type: "trigger",
        label: "Início",
        position: pos,
        config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
      },
      noPonderado(config),
      ...ramos.map((r) => ({
        id: `f-${r}`,
        type: "end",
        label: `Fim ${r}`,
        position: pos,
        config: { outcome: "converted" },
      })),
    ],
    edges: [
      { id: "e0", source: "n1", target: "s1", priority: 0, condition: sempre },
      ...ramos.filter((r) => !sem.includes(r)).map((r) => arestaDoRamo(r)),
    ],
  });
}

describe("ramoSorteado: as faixas acumuladas", () => {
  const ramos = LETRAS.map((id, i) => ({ id, peso: PESOS_DA_ROLETA[i]! }));

  it.each([
    [0, "a"],
    [0.1699, "a"],
    [0.17, "b"],
    [0.3199, "b"],
    [0.32, "c"],
    [0.4899, "c"],
    [0.49, "d"],
    [0.66, "e"],
    [0.83, "f"],
    [0.9999, "f"],
  ])("sorteado %f cai em %s", (sorteado, esperado) => {
    expect(ramoSorteado(ramos, sorteado)).toBe(esperado);
  });

  it("o ramo de peso 0 (g) nunca sai em 10.000 sorteios", () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 10_000; i++) vistos.add(ramoSorteado(ramos, i / 10_000));
    expect(vistos.has("g")).toBe(false);
    expect([...vistos].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("o ramo de peso 0 no meio também nunca sai, e quem tem 100 recebe todos", () => {
    const meio = [
      { id: "a", peso: 50 },
      { id: "b", peso: 0 },
      { id: "c", peso: 50 },
    ];
    for (let i = 0; i < 1_000; i++) expect(ramoSorteado(meio, i / 1_000)).not.toBe("b");
    const so = [
      { id: "a", peso: 0 },
      { id: "b", peso: 100 },
    ];
    for (let i = 0; i < 1_000; i++) expect(ramoSorteado(so, i / 1_000)).toBe("b");
  });

  it("arredondamento além do fim cai na última saída COM peso, nunca na reservada", () => {
    expect(ramoSorteado(ramos, 1)).toBe("f");
  });
});

describe("schema do sorteio ponderado", () => {
  const ok = (ramos: unknown) => sorteioConfigSchema.safeParse({ ramos }).success;

  it("aceita de 2 a 10 saídas somando 100, inclusive com peso 0", () => {
    expect(ok([{ peso: 50 }, { peso: 50 }])).toBe(true);
    expect(ok(ramosDaRoleta())).toBe(true);
    expect(ok([{ peso: 100 }, { peso: 0 }])).toBe(true);
    expect(ok([{ peso: 10 }, ...Array.from({ length: 9 }, () => ({ peso: 10 }))])).toBe(true);
  });

  it("recusa soma diferente de 100", () => {
    expect(ok([{ peso: 50 }, { peso: 49 }])).toBe(false);
    expect(ok([{ peso: 50 }, { peso: 51 }])).toBe(false);
    expect(ok([{ peso: 0 }, { peso: 0 }])).toBe(false);
  });

  it("recusa 1 saída e 11 saídas", () => {
    expect(ok([{ peso: 100 }])).toBe(false);
    expect(ok([])).toBe(false);
    const onze = [{ peso: 90 }, ...Array.from({ length: 10 }, () => ({ peso: 1 }))];
    expect(onze).toHaveLength(11);
    expect(ok(onze)).toBe(false);
  });

  it("recusa peso negativo, não inteiro, acima de 100 ou que não é número", () => {
    expect(ok([{ peso: -10 }, { peso: 110 }])).toBe(false);
    expect(ok([{ peso: 50.5 }, { peso: 49.5 }])).toBe(false);
    expect(ok([{ peso: 101 }, { peso: -1 }])).toBe(false);
    expect(ok([{ peso: "50" }, { peso: 50 }])).toBe(false);
    expect(ok([{ peso: Number.NaN }, { peso: 50 }])).toBe(false);
  });

  it("recusa chave desconhecida e nome longo demais; o nome é aparado", () => {
    expect(ok([{ peso: 50, extra: 1 }, { peso: 50 }])).toBe(false);
    expect(ok([{ peso: 50, nome: "x".repeat(41) }, { peso: 50 }])).toBe(false);
    const r = sorteioConfigSchema.safeParse({ ramos: [{ peso: 50, nome: "  Kyla  " }, { peso: 50 }] });
    expect(r.success && "ramos" in r.data && r.data.ramos[0]!.nome).toBe("Kyla");
  });

  it("recusa nome com caractere de controle ou de formato (U+202E, quebra de linha)", () => {
    expect(ok([{ peso: 50, nome: "Ana\u202Eadmin" }, { peso: 50 }])).toBe(false);
    expect(ok([{ peso: 50, nome: "Ana\u200Bx" }, { peso: 50 }])).toBe(false);
    expect(ok([{ peso: 50, nome: "Ana\nBia" }, { peso: 50 }])).toBe(false);
    expect(ok([{ peso: 50, nome: "Ana Lúcia" }, { peso: 50 }])).toBe(true);
  });

  it("não mistura as duas formas", () => {
    expect(sorteioConfigSchema.safeParse({ percent_a: 50, ramos: [{ peso: 50 }, { peso: 50 }] }).success).toBe(false);
  });
});

describe("saídas do sorteio ponderado", () => {
  it("uma saída por ramo, ids a..g, com o nome e o peso no rótulo", () => {
    const ramos = nodeBranches(noPonderado());
    expect(ramos.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(ramos.map((r) => r.label)).toEqual([
      "A · Kyla (17%)",
      "B · Bruno (15%)",
      "C · Ana (17%)",
      "D · Caio (17%)",
      "E · Davi (17%)",
      "F · Eva (17%)",
      "G · Reserva (0%)",
    ]);
    expect(ramos.map((r) => r.condition)).toEqual(
      LETRAS.map((id) => ({ type: "branch", branch_id: id })),
    );
  });

  it("sem nome o rótulo é só a letra e o peso", () => {
    const sem = noPonderado({ ramos: [{ peso: 70 }, { peso: 30 }, { peso: 0 }] });
    expect(nodeBranches(sem).map((r) => r.label)).toEqual(["A (70%)", "B (30%)", "C (0%)"]);
    expect(rotuloDoRamoDoSorteio({ id: "a", letra: "A", peso: 5, nome: "Lia" })).toBe("A · Lia (5%)");
  });
});

describe("decisão do sorteio ponderado (fonte injetada)", () => {
  const edges = LETRAS.map((r) => arestaDoRamo(r));
  const decidirPonderado = (sorteado: number, es: FlowEdge[] = edges, config = configDaRoleta()) =>
    processNode({
      node: noPonderado(config),
      edges: es,
      enrollment,
      lead,
      clock: () => AGORA,
      sortear: () => sorteado,
    });

  it("segue pela aresta do ramo sorteado", () => {
    expect(decidirPonderado(0)).toMatchObject({ kind: "advance", next_node_id: "f-a", branch: "a" });
    expect(decidirPonderado(0.17)).toMatchObject({ kind: "advance", next_node_id: "f-b", branch: "b" });
    expect(decidirPonderado(0.5)).toMatchObject({ kind: "advance", next_node_id: "f-d", branch: "d" });
    expect(decidirPonderado(0.9999)).toMatchObject({ kind: "advance", next_node_id: "f-f", branch: "f" });
  });

  it("o desfecho não vai em `class`", () => {
    expect(decidirPonderado(0.3)).not.toHaveProperty("class");
  });

  it("ramo sorteado sem aresta ligada encerra a execução, nunca cai em outro", () => {
    const semB = edges.filter((e) => e.id !== "e-b");
    expect(decidirPonderado(0.2, semB)).toEqual({ kind: "complete", outcome: null });
    expect(decidirPonderado(0.1, semB)).toMatchObject({ next_node_id: "f-a" });
  });

  it("saidaDoSorteio: a forma legada segue a mesma regra de ladoDoSorteio", () => {
    for (const percentA of [1, 30, 50, 99]) {
      for (let i = 0; i < 100; i++) {
        const x = i / 100;
        expect(saidaDoSorteio({ percent_a: percentA }, x), `${percentA}/${x}`).toBe(ladoDoSorteio(percentA, x));
      }
    }
  });

  it("a forma legada {percent_a} continua decidindo e rotulando A/B igual", () => {
    const legado = [aresta("e1", "x", "a"), aresta("e2", "y", "b")];
    expect(decidir(30, 0.29, legado)).toMatchObject({ next_node_id: "x", branch: "a" });
    expect(decidir(30, 0.3, legado)).toMatchObject({ next_node_id: "y", branch: "b" });
    expect(nodeBranches(no(30)).map((r) => r.label)).toEqual(["A (30%)", "B (70%)"]);
  });

  it("a fonte real nunca sorteia o ramo de peso 0 e respeita as faixas (±2 pontos)", () => {
    const total = 10_000;
    const contagem: Record<string, number> = {};
    for (let i = 0; i < total; i++) {
      const r = processNode({ node: noPonderado(), edges, enrollment, lead, clock: () => AGORA });
      if (r.kind === "advance") contagem[r.branch ?? "?"] = (contagem[r.branch ?? "?"] ?? 0) + 1;
    }
    expect(contagem.g ?? 0).toBe(0);
    LETRAS.slice(0, 6).forEach((id, i) => {
      expect(Math.abs(((contagem[id] ?? 0) / total) * 100 - PESOS_DA_ROLETA[i]!), id).toBeLessThanOrEqual(2);
    });
  });
});

describe("publicação do sorteio ponderado", () => {
  it("com as sete saídas ligadas publica", () => {
    expect(validateFlowForPublish(grafoPonderado(), { surface: "automacao" })).toEqual({ ok: true });
  });

  it("a saída reservada (g) sem ligação é recusada, nomeando qual", () => {
    const r = validateFlowForPublish(grafoPonderado(["g"]), { surface: "automacao" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContainEqual(
      expect.objectContaining({ node_id: "s1", code: "missing_branch_edge", branch_id: "g" }),
    );
    expect(r.errors.find((e) => e.branch_id === "g")?.message).toContain("G · Reserva (0%)");
    expect(r.errors.filter((e) => e.code === "missing_branch_edge")).toHaveLength(1);
  });

  it("várias saídas soltas geram um erro por saída", () => {
    const r = validateFlowForPublish(grafoPonderado(["b", "e"]), { surface: "automacao" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(
      r.errors.filter((e) => e.code === "missing_branch_edge").map((e) => e.branch_id).sort(),
    ).toEqual(["b", "e"]);
  });

  it("o ponderado também não publica num follow-up", () => {
    const r = validateFlowForPublish(grafoPonderado(), { surface: "followup" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("no_fora_da_superficie");
  });

  it("o grafo com soma ≠ 100 nem passa pelo schema do fluxo", () => {
    expect(() =>
      flowGraphSchema.parse({
        ...grafoPonderado(),
        nodes: grafoPonderado().nodes.map((n) =>
          n.type === "random_split" ? { ...n, config: { ramos: [{ peso: 60 }, { peso: 60 }] } } : n,
        ),
      }),
    ).toThrow();
  });
});

describe("exportar e importar o sorteio ponderado", () => {
  it("o bloco volta igual, com os nomes, os pesos e as sete saídas", () => {
    const original = grafoPonderado();
    const arquivo = exportarAutomacao(
      { id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "Roleta", grafo: original },
      [],
      AGORA,
    );
    const leitura = lerArquivoDeAutomacao(JSON.parse(JSON.stringify(arquivo)));
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    const m = montarGrafoImportado(leitura.arquivo, leitura.usadas, {}, [], "bbbbbbbb-0000-4000-8000-000000000001");
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.grafo).toEqual(original);
    const sorteio = m.grafo.nodes.find((n) => n.type === "random_split");
    expect(sorteio?.config).toEqual(configDaRoleta());
  });

  it("soma adulterada no arquivo é recusada", () => {
    const arquivo = exportarAutomacao(
      { id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "x", grafo: grafoPonderado() },
      [],
      AGORA,
    );
    const adulterado = JSON.parse(JSON.stringify(arquivo)) as {
      automacao: { grafo: { nodes: Array<{ type: string; config: { ramos?: Array<{ peso: number }> } }> } };
    };
    adulterado.automacao.grafo.nodes.find((n) => n.type === "random_split")!.config.ramos![0]!.peso = 90;
    expect(lerArquivoDeAutomacao(adulterado).ok).toBe(false);
  });
});
