import { describe, expect, it } from "vitest";

import { filtrarLista, montarListaUnica, ultimaExecucaoPorPonteiro } from "./lista-unica";

const P = (id: string, surface: string | null, status = "active", updated_at = "2026-11-01") => ({
  id,
  name: `Nome ${id}`,
  status,
  surface,
  updated_at,
});

describe("montarListaUnica", () => {
  const base = {
    automacoes: [P("a1", "automacao", "active", "2026-11-05")],
    followups: [
      P("f1", "followup", "disabled", "2026-11-03"),
      P("f2", null, "draft", "2026-11-02"),
      P("x", "atendimento"),
    ],
    regras: [
      {
        id: "r1",
        name: "Ação antiga",
        is_active: true,
        last_run_at: "2026-11-09",
        updated_at: "2026-11-04",
        migrated_to_pointer_id: null,
        conversivel: true,
      },
      {
        id: "r2",
        name: "E-mail",
        is_active: false,
        last_run_at: null,
        updated_at: "2026-11-01",
        migrated_to_pointer_id: null,
        conversivel: false,
      },
      {
        id: "r3",
        name: "Já virou",
        is_active: false,
        last_run_at: null,
        updated_at: "2026-11-06",
        migrated_to_pointer_id: "a1",
        conversivel: true,
      },
    ],
    ultimasExecucoes: { a1: "2026-11-08", f1: "2026-11-07" },
  };

  it("junta os três tipos, sem roteiro de atendimento, e não mostra duas vezes a regra convertida", () => {
    const l = montarListaUnica(base);
    expect(l.map((x) => [x.id, x.tipo])).toEqual([
      ["a1", "automacao"],
      ["r1", "regra"],
      ["f1", "followup"],
      ["f2", "followup"],
      ["r2", "regra"],
    ]);
  });

  it("diz para onde cada linha abre e o que está ligado", () => {
    const porId = Object.fromEntries(montarListaUnica(base).map((x) => [x.id, x]));
    expect(porId.a1).toMatchObject({
      href: "/app/automacoes/a1",
      ligado: true,
      ultimaExecucao: "2026-11-08",
    });
    expect(porId.f1).toMatchObject({
      href: "/app/ai/followups/f1",
      ligado: false,
      ultimaExecucao: "2026-11-07",
    });
    expect(porId.r1).toMatchObject({
      href: "/app/automacoes/converter/r1",
      ligado: true,
      ultimaExecucao: "2026-11-09",
      conversivel: true,
    });
    expect(porId.r2).toMatchObject({
      href: "/app/webhooks?tab=rules&regra=r2",
      conversivel: false,
    });
  });

  it("filtro por tipo e busca sem acento", () => {
    const l = montarListaUnica(base);
    expect(filtrarLista(l, "regra", "").map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(filtrarLista(l, "todos", "acao").map((x) => x.id)).toEqual(["r1"]);
    expect(filtrarLista(l, "followup", "nome f2").map((x) => x.id)).toEqual(["f2"]);
  });

  it("última execução: a mais recente por ponteiro", () => {
    expect(
      ultimaExecucaoPorPonteiro([
        { pointer_id: "a", started_at: "2026-11-02" },
        { pointer_id: "a", started_at: "2026-11-05" },
        { pointer_id: "b", started_at: null },
      ]),
    ).toEqual({ a: "2026-11-05" });
  });
});
