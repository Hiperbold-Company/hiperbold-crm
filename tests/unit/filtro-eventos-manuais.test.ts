import { describe, expect, it } from "vitest";

import {
  applyFilters,
  atendeEventosManuais,
  filtersFromParams,
  filtersToParams,
  filtroDeEventosManuaisFromParam,
} from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";

/**
 * O filtro "Eventos manuais" do quadro do funil (pedido da CBEXS, 28/10/2026).
 *
 * A contagem é do banco (`fn_contar_eventos_manuais_do_funil`, provada em
 * `tests/invariants/contagem-de-eventos-manuais.test.ts`); aqui se prova o
 * critério de comparação, o estado na URL e o efeito no quadro.
 */
function lead(id: string): Lead {
  return {
    id,
    title: `Negócio ${id}`,
    description: null,
    status: "open",
    owner_user_id: null,
    owner_agent_id: null,
    tags: [],
    value_cents: null,
    expected_close_date: null,
    created_at: "2026-10-01T12:00:00.000Z",
    stage_changed_at: null,
    lost_reason: null,
  } as unknown as Lead;
}

describe("atendeEventosManuais — o critério", () => {
  it("menor que / igual a / maior que, com a fronteira exata", () => {
    expect(atendeEventosManuais(4, { op: "lt", n: 5 })).toBe(true);
    expect(atendeEventosManuais(5, { op: "lt", n: 5 })).toBe(false);
    expect(atendeEventosManuais(5, { op: "eq", n: 5 })).toBe(true);
    expect(atendeEventosManuais(6, { op: "eq", n: 5 })).toBe(false);
    expect(atendeEventosManuais(6, { op: "gt", n: 5 })).toBe(true);
    expect(atendeEventosManuais(5, { op: "gt", n: 5 })).toBe(false);
  });

  it("'igual a 0' acha quem nunca teve registro manual", () => {
    expect(atendeEventosManuais(0, { op: "eq", n: 0 })).toBe(true);
    expect(atendeEventosManuais(1, { op: "eq", n: 0 })).toBe(false);
  });
});

describe("estado na URL", () => {
  it("ida e volta: eventos=gt:5", () => {
    const qs = filtersToParams({ manualEvents: { op: "gt", n: 5 } });
    expect(qs).toBe("eventos=gt%3A5");
    expect(filtersFromParams(new URLSearchParams(qs)).manualEvents).toEqual({ op: "gt", n: 5 });
  });

  it("valor malformado é filtro ausente, nunca número inventado", () => {
    for (const ruim of ["gt", "gt:", "gt:-1", "gt:1.5", "maior:5", "gt:abc", ""]) {
      expect(filtroDeEventosManuaisFromParam(ruim)).toBeUndefined();
    }
    expect(filtersToParams({})).toBe("");
  });
});

describe("applyFilters com a contagem do servidor", () => {
  const leads = [lead("a"), lead("b"), lead("c")];
  const contagem = new Map([
    ["a", 6],
    ["b", 5],
  ]); // "c" ausente = zero

  it("maior que 5: só quem tem 6+", () => {
    const r = applyFilters(
      leads,
      { manualEvents: { op: "gt", n: 5 } },
      { eventosManuais: contagem },
    );
    expect(r.map((l) => l.id)).toEqual(["a"]);
  });

  it("igual a 0: o negócio ausente do mapa conta como zero", () => {
    const r = applyFilters(
      leads,
      { manualEvents: { op: "eq", n: 0 } },
      { eventosManuais: contagem },
    );
    expect(r.map((l) => l.id)).toEqual(["c"]);
  });

  it("menor que 6: 5 e 0 passam", () => {
    const r = applyFilters(
      leads,
      { manualEvents: { op: "lt", n: 6 } },
      { eventosManuais: contagem },
    );
    expect(r.map((l) => l.id)).toEqual(["b", "c"]);
  });

  it("contagem ainda não chegou: o filtro não esvazia o quadro", () => {
    const r = applyFilters(leads, { manualEvents: { op: "gt", n: 5 } }, {});
    expect(r).toHaveLength(3);
  });
});
