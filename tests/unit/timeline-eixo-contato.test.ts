import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { comOrigemDoNegocio } from "@/lib/leads/timeline-query";
import { createClient } from "@/lib/supabase/server";
import type { TimelineItemView } from "@/lib/types/contacts";

import { GET } from "@/app/api/v1/leads/[id]/timeline/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const LEAD = "11111111-1111-4111-8111-111111111111";
const IRMAO = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const FUNIL_A = "44444444-4444-4444-8444-444444444444";
const FUNIL_B = "55555555-5555-4555-8555-555555555555";
const ORG = "66666666-6666-4666-8666-666666666666";

function linha(id: string, lead_id: string): TimelineItemView {
  return {
    id,
    organization_id: ORG,
    lead_id,
    contact_id: CONTATO,
    source_module: "x",
    source_id: null,
    type: "stage_changed",
    payload: {},
    metadata: {},
    performed_at: "2026-10-19T12:00:00.000Z",
    performed_by_user_id: null,
  };
}

/** Tabelas simuladas que APLICAM `eq` e `in`, para a organização valer de verdade. */
function tabelasFalsas(tabelas: Record<string, Array<Record<string, unknown>>>) {
  return {
    from: (t: string) => {
      const filtros: Array<(r: Record<string, unknown>) => boolean> = [];
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          filtros.push((r) => r[c] === v);
          return b;
        },
        in: (c: string, vals: string[]) => {
          filtros.push((r) => vals.includes(r[c] as string));
          return b;
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: tabelas[t]!.filter((r) => filtros.every((f) => f(r))), error: null }),
      };
      return b;
    },
  } as never;
}

describe("comOrigemDoNegocio", () => {
  const tabelas = {
    crm_leads: [
      { id: LEAD, title: "Negócio A", pipeline_id: FUNIL_A, organization_id: ORG },
      { id: IRMAO, title: "Negócio B", pipeline_id: FUNIL_B, organization_id: ORG },
    ],
    crm_pipelines: [
      { id: FUNIL_A, name: "FUTURO 2026", organization_id: ORG },
      { id: FUNIL_B, name: "FUTURO 2027", organization_id: ORG },
    ],
  };

  it("anexa o título do negócio e o nome do funil a cada linha", async () => {
    const r = await comOrigemDoNegocio(tabelasFalsas(tabelas), [linha("a", LEAD), linha("b", IRMAO)], ORG);
    expect(r[0]).toMatchObject({ negocio_titulo: "Negócio A", funil_nome: "FUTURO 2026" });
    expect(r[1]).toMatchObject({ negocio_titulo: "Negócio B", funil_nome: "FUTURO 2027" });
  });

  it("defesa em profundidade: negócio de OUTRA organização não empresta título nem funil", async () => {
    const r = await comOrigemDoNegocio(
      tabelasFalsas(tabelas),
      [linha("a", LEAD)],
      "99999999-9999-4999-8999-999999999999",
    );
    expect(r[0]).toMatchObject({ negocio_titulo: null, funil_nome: null });
  });

  it("negócio que não se enxerga (apagado, RLS) vira nulo, sem derrubar a linha", async () => {
    const r = await comOrigemDoNegocio(
      tabelasFalsas({ crm_leads: [], crm_pipelines: [] }),
      [linha("a", IRMAO)],
      ORG,
    );
    expect(r[0]).toMatchObject({ id: "a", negocio_titulo: null, funil_nome: null });
  });

  it("lista vazia não consulta nada", async () => {
    const supabase = {
      from: () => {
        throw new Error("não devia consultar");
      },
    } as never;
    await expect(comOrigemDoNegocio(supabase, [], ORG)).resolves.toEqual([]);
  });
});

/**
 * A rota, com um banco que GRAVA os filtros recebidos: prova o que ela pergunta
 * ao banco em cada escopo, sem reimplementar o PostgREST. A junção real e a RLS
 * em modo `own` são provadas em `tests/invariants/evento-manual-autoria-e-escopo-contato`.
 */
describe("GET /api/v1/leads/[id]/timeline", () => {
  let ors: string[];
  let eqs: Array<[string, string, unknown]>;
  let selects: string[];
  let urlsComLista: string[];

  function banco(contactId: string | null) {
    const atividades = [
      { ...linha("a1", LEAD), crm_leads: { contact_id: CONTATO } },
      { ...linha("b1", IRMAO), crm_leads: { contact_id: CONTATO } },
    ];
    return {
      from: (tabela: string) => {
        const b: Record<string, unknown> = {
          select: (cols?: string) => {
            if (tabela === "crm_lead_activities") selects.push(cols ?? "");
            return b;
          },
          eq: (c: string, v: unknown) => {
            eqs.push([tabela, c, v]);
            return b;
          },
          in: (col: string, vals: string[]) => {
            urlsComLista.push(`${tabela}:${col}`);
            if (tabela === "crm_leads")
              return Promise.resolve({
                data: vals.map((id) => ({
                  id,
                  title: id === IRMAO ? "Negócio B" : "Negócio A",
                  pipeline_id: id === IRMAO ? FUNIL_B : FUNIL_A,
                })),
                error: null,
              });
            if (tabela === "crm_pipelines")
              return Promise.resolve({
                data: vals.map((id) => ({ id, name: id === FUNIL_B ? "FUTURO 2027" : "FUTURO 2026" })),
                error: null,
              });
            return Promise.resolve({ data: [], error: null });
          },
          order: () => b,
          limit: () => b,
          or: (expr: string) => {
            ors.push(expr);
            return b;
          },
          maybeSingle: async () => ({ data: { id: LEAD, contact_id: contactId }, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: atividades, error: null }),
        };
        return b;
      },
    } as never;
  }

  beforeEach(() => {
    ors = [];
    eqs = [];
    selects = [];
    urlsComLista = [];
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u", idioma: "pt-BR" },
      org: { orgId: ORG },
    } as never);
  });

  const chama = (qs: string, id = LEAD) =>
    GET(new NextRequest(`http://localhost/api/v1/leads/${id}/timeline${qs}`), {
      params: Promise.resolve({ id }),
    });

  it("escopo=contato: junção com o negócio filtrada pelo contato — SEM lista de ids na URL", async () => {
    vi.mocked(createClient).mockResolvedValue(banco(CONTATO));
    const res = await chama("?escopo=contato");
    expect(res.status).toBe(200);
    expect(selects[0]).toContain("crm_leads!inner(contact_id)");
    expect(eqs).toContainEqual(["crm_lead_activities", "crm_leads.contact_id", CONTATO]);
    expect(ors).toHaveLength(0);
    // nenhum `lead_id in (...)` montado sobre os negócios do contato
    expect(urlsComLista).not.toContain("crm_lead_activities:lead_id");
    expect(urlsComLista).not.toContain("crm_leads:contact_id");
  });

  it("escopo=contato: devolve a origem de cada linha e NÃO vaza a junção", async () => {
    vi.mocked(createClient).mockResolvedValue(banco(CONTATO));
    const { data } = await (await chama("?escopo=contato")).json();
    expect(data.find((d: { id: string }) => d.id === "b1")).toMatchObject({
      negocio_titulo: "Negócio B",
      funil_nome: "FUTURO 2027",
    });
    for (const d of data) expect(d).not.toHaveProperty("crm_leads");
  });

  it("toda consulta leva a organização da sessão (defesa em profundidade além da RLS)", async () => {
    vi.mocked(createClient).mockResolvedValue(banco(CONTATO));
    await chama("?escopo=contato");
    for (const tabela of ["crm_leads", "crm_lead_activities", "crm_pipelines"]) {
      expect(eqs, tabela).toContainEqual([tabela, "organization_id", ORG]);
    }
  });

  it("sem o parâmetro, o eixo continua sendo o do negócio (o irmão fica de fora) e sem origem", async () => {
    vi.mocked(createClient).mockResolvedValue(banco(CONTATO));
    const res = await chama("");
    expect(res.status).toBe(200);
    expect(ors[0]).not.toContain(IRMAO);
    expect(selects[0]).not.toContain("crm_leads!inner");
    const { data } = await res.json();
    expect(data[0]).not.toHaveProperty("negocio_titulo");
  });

  it("negócio SEM contato: escopo=contato cai no eixo do negócio, não quebra", async () => {
    vi.mocked(createClient).mockResolvedValue(banco(null));
    const res = await chama("?escopo=contato");
    expect(res.status).toBe(200);
    expect(ors).toHaveLength(0);
    expect(selects[0]).not.toContain("crm_leads!inner");
    expect(eqs).toContainEqual(["crm_lead_activities", "lead_id", LEAD]);
  });

  it("id que não é UUID é 404 e não toca o banco", async () => {
    vi.mocked(createClient).mockResolvedValue(banco(CONTATO));
    const res = await chama("", "nao-e-uuid");
    expect(res.status).toBe(404);
    expect(eqs).toHaveLength(0);
  });
});
