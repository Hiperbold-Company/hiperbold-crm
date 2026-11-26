/**
 * NAVEGAÇÃO POR ÁREAS DO V49 — onda 1 do redesign.
 *
 * O menu da moldura nova deixa de listar telas soltas (Chat, Radar, Agentes…)
 * e passa a listar as ÁREAS do protótipo v49. A faixa de abas segue a área da
 * tela, não o grupo do catálogo: Pipeline e Contatos deixam de mostrar as
 * mesmas abas. A IA ganha a coluna lateral Montar / Ensinar / Acompanhar.
 *
 * Permissão não mora aqui: as funções recebem os destinos que o catálogo já
 * deixou o papel ver e só os ORGANIZAM. Destino escondido não aparece.
 */
import { describe, expect, it } from "vitest";

import { NAV_CATALOG } from "@/lib/navigation/catalogo";
import {
  AREAS_DO_V49,
  abasDaAreaV49,
  areaDaTela,
  areasDoMenu,
  gruposDaIA,
} from "@/lib/redesign/areas";

const todos = NAV_CATALOG.map((d) => ({ href: d.href }));
const sem = (...fora: string[]) => todos.filter((d) => !fora.includes(d.href));
const hrefs = (xs: ReadonlyArray<{ href: string }>) => xs.map((x) => x.href);

describe("areasDoMenu — as áreas do v49, na ordem do protótipo", () => {
  it("com tudo visível, o menu é Início, Conversas, Pipeline, Contatos, Tarefas, Agenda, Métricas, IA, Automações", () => {
    expect(areasDoMenu(todos).map((a) => a.id)).toEqual([
      "inicio",
      "conversas",
      "pipeline",
      "contatos",
      "tarefas",
      "agenda",
      "metricas",
      "ia",
      "automacoes",
    ]);
  });

  it("os rótulos são os do v49", () => {
    expect(areasDoMenu(todos).map((a) => a.rotulo)).toEqual([
      "Início",
      "Conversas",
      "Pipeline",
      "Contatos",
      "Tarefas",
      "Agenda",
      "Métricas",
      "IA",
      "Automações",
    ]);
  });

  it("Conexões não está no menu (no v49 ela fica no Mais)", () => {
    expect(areasDoMenu(todos).map((a) => a.id)).not.toContain("conexoes");
  });

  it("o link da área é a primeira aba que o papel vê", () => {
    const conversas = areasDoMenu(sem("/app/inbox")).find((a) => a.id === "conversas");
    expect(conversas?.href).toBe("/app/radar");
    expect(areasDoMenu(todos).find((a) => a.id === "pipeline")?.href).toBe("/app/kanban");
  });

  it("área sem nenhuma aba visível some do menu", () => {
    const semAgenda = sem("/app/agenda", "/app/settings/tenant/agenda", "/app/agenda/avisos");
    expect(areasDoMenu(semAgenda).map((a) => a.id)).not.toContain("agenda");
  });

  it("não inventa porta: com nada visível, o menu é vazio", () => {
    expect(areasDoMenu([])).toEqual([]);
  });
});

describe("abasDaAreaV49 — a faixa segue a área, na ordem do v49", () => {
  const area = (id: string) => AREAS_DO_V49.find((a) => a.id === id)!;

  it("Pipeline: Pipeline, Etapas do funil, Produtos, Propostas", () => {
    expect(hrefs(abasDaAreaV49(area("pipeline"), todos))).toEqual([
      "/app/kanban",
      "/app/settings/tenant/pipelines",
      "/app/products",
      "/app/proposals",
    ]);
  });

  it("Contatos: Contatos, Campanhas, Importações — e não as abas do Pipeline", () => {
    const contatos = hrefs(abasDaAreaV49(area("contatos"), todos));
    expect(contatos.slice(0, 3)).toEqual(["/app/contacts", "/app/campaigns", "/app/imports"]);
    expect(contatos).not.toEqual(hrefs(abasDaAreaV49(area("pipeline"), todos)));
  });

  it("Conversas: Chat, Radar, Respostas rápidas", () => {
    expect(hrefs(abasDaAreaV49(area("conversas"), todos))).toEqual([
      "/app/inbox",
      "/app/radar",
      "/app/templates",
    ]);
  });

  it("Tarefas começa por Tarefas, Planos de tarefa, Chamadas, Prospecção", () => {
    expect(hrefs(abasDaAreaV49(area("tarefas"), todos)).slice(0, 4)).toEqual([
      "/app/tasks",
      "/app/tasks/planos",
      "/app/calls",
      "/app/prospecting",
    ]);
  });

  it("Agenda: Agenda, Tipos de agendamento, Aviso de agendamento", () => {
    expect(hrefs(abasDaAreaV49(area("agenda"), todos))).toEqual([
      "/app/agenda",
      "/app/settings/tenant/agenda",
      "/app/agenda/avisos",
    ]);
  });

  it("Métricas começa por Desempenho, Atividades, Faturamento, Evolução da IA, Histórico de ações", () => {
    expect(hrefs(abasDaAreaV49(area("metricas"), todos)).slice(0, 5)).toEqual([
      "/app/metrics",
      "/app/activities",
      "/app/faturamento",
      "/app/ai/evolution",
      "/app/audit",
    ]);
  });

  it("aba que o papel não vê sai da faixa, sem furar a ordem", () => {
    expect(hrefs(abasDaAreaV49(area("pipeline"), sem("/app/products")))).toEqual([
      "/app/kanban",
      "/app/settings/tenant/pipelines",
      "/app/proposals",
    ]);
  });
});

describe("areaDaTela — em que área a pessoa está", () => {
  const casos: Array<[string, string | null]> = [
    ["/app/inicio", "inicio"],
    ["/app/inbox/abc", "conversas"],
    ["/app/radar", "conversas"],
    ["/app/kanban", "pipeline"],
    ["/app/pipelines/683f0376", "pipeline"],
    ["/app/settings/tenant/pipelines", "pipeline"],
    ["/app/proposals/novo", "pipeline"],
    ["/app/contacts/123", "contatos"],
    ["/app/campaigns/new", "contatos"],
    ["/app/tasks/planos", "tarefas"],
    ["/app/calls", "tarefas"],
    ["/app/settings/tenant/agenda", "agenda"],
    ["/app/agenda/avisos", "agenda"],
    ["/app/audit", "metricas"],
    ["/app/ai/evolution", "metricas"],
    ["/app/ai/knowledge/sources/9", "ia"],
    ["/app/ai/cases/avisos", "ia"],
    ["/app/automacoes/77", "automacoes"],
    ["/app/connections", "conexoes"],
    ["/app/settings/tenant", null],
    ["/app/settings/profile", null],
  ];

  it.each(casos)("%s → %s", (caminho, esperado) => {
    expect(areaDaTela(caminho, todos)?.id ?? null).toBe(esperado);
  });

  it("Evolução da IA é de Métricas mesmo morando em /app/ai (o caminho mais longo decide)", () => {
    expect(areaDaTela("/app/ai/evolution", todos)?.id).toBe("metricas");
  });

  it("tela que o papel não vê não acende área", () => {
    expect(areaDaTela("/app/audit", sem("/app/audit"))).toBeNull();
  });
});

describe("gruposDaIA — a coluna lateral da IA (Montar, Ensinar, Acompanhar)", () => {
  it("três grupos, na ordem e com as telas do v49", () => {
    const grupos = gruposDaIA(todos);
    expect(grupos.map((g) => g.rotulo)).toEqual(["Montar", "Ensinar", "Acompanhar"]);
    expect(hrefs(grupos[0]!.itens).slice(0, 4)).toEqual([
      "/app/ai/agents",
      "/app/ai/followups",
      "/app/ai/routers",
      "/app/ai/jev",
    ]);
    expect(hrefs(grupos[1]!.itens)).toEqual([
      "/app/ai/knowledge/sources",
      "/app/ai/memory",
      "/app/ai/skills",
      "/app/ai/mcp",
    ]);
    expect(hrefs(grupos[2]!.itens)).toEqual(
      expect.arrayContaining(["/app/ai/cases", "/app/ai/inbox", "/app/ai/proposals", "/app/ai/runs"]),
    );
  });

  it("tela escondida sai do grupo; grupo vazio some", () => {
    const grupos = gruposDaIA(
      sem("/app/ai/knowledge/sources", "/app/ai/memory", "/app/ai/skills", "/app/ai/mcp"),
    );
    expect(grupos.map((g) => g.rotulo)).toEqual(["Montar", "Acompanhar"]);
  });
});

describe("cerca — nenhuma porta fantasma", () => {
  it("todo caminho declarado nas áreas existe no catálogo", () => {
    const doCatalogo = new Set<string>(NAV_CATALOG.map((d) => d.href));
    const declarados = AREAS_DO_V49.flatMap((a) => a.abas);
    const fantasmas = declarados.filter((h) => !doCatalogo.has(h));
    expect(fantasmas).toEqual([]);
  });

  it("nenhum caminho está em duas áreas (a aba acesa seria ambígua)", () => {
    const declarados = AREAS_DO_V49.flatMap((a) => a.abas);
    const repetidos = declarados.filter((h, i) => declarados.indexOf(h) !== i);
    expect(repetidos).toEqual([]);
  });
});
