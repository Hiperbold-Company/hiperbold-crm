/**
 * 1015 — a fila de propostas de campo: a proposta de um campo NÃO PÚBLICO some (chave e valores)
 * para quem não é administrador. Os dublês são só a fronteira (sessão e Supabase); o recorte e a
 * leitura das chaves restritas são o código real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));

import { GET } from "./route";

const LEAD = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: LEAD }) };
const req = () => new NextRequest(`http://localhost/api/v1/leads/${LEAD}/field-proposals`);

function cadeia(resp: unknown) {
  const r = resp as { data: unknown; error: unknown };
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "gt", "order", "limit", "update"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error });
  c.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(r).then(ok, ko);
  return c;
}
function cliente(tabelas: Record<string, unknown>, user: unknown = { id: "u1" }) {
  return {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (t: string) => cadeia(tabelas[t] ?? { data: [], error: null }),
  };
}
const certo = (data: unknown) => ({ data, error: null });

const FUNIL = {
  settings: {
    fields: [
      { key: "cpf", label: "CPF", type: "text", publico: false },
      { key: "hotel", label: "Hotel", type: "text" },
    ],
  },
};
const linha = (id: string, campo: string, valor: string) => ({
  id,
  campo,
  valor_proposto: valor,
  valor_anterior: null,
  trecho: `trecho ${valor}`,
  attachment_id: null,
  proposed_at: "2026-11-01T10:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
  crm_lead_attachments: null,
});

function monta(role: string) {
  deps.role.mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org", role } });
  deps.client.mockResolvedValue(
    cliente({
      crm_leads: certo({ id: LEAD, pipeline_id: "p1", custom_fields: { cpf: "111.222.333-44", hotel: "Antigo" } }),
      crm_pipelines: certo([FUNIL]),
      custom_field_definitions: certo([]),
      lead_field_proposals: certo([linha("a", "cpf", "999.888.777-66"), linha("b", "hotel", "Mar Azul")]),
    }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/leads/:id/field-proposals — campo restrito (1015)", () => {
  it.each(["viewer", "agent", "manager"])("%s: a proposta do campo restrito some, sem chave nem valor", async (role) => {
    monta(role);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const texto = await res.text();
    const corpo = JSON.parse(texto) as { data: { propostas: Array<{ campo: string }> } };
    expect(corpo.data.propostas.map((p) => p.campo)).toEqual(["hotel"]);
    expect(texto).not.toContain("999.888.777-66");
    expect(texto).not.toContain("111.222.333-44");
  });

  it("admin: vê a proposta restrita com valor atual e proposto", async () => {
    monta("admin");
    const res = await GET(req(), ctx);
    const corpo = (await res.json()) as {
      data: { propostas: Array<{ campo: string; valor_atual: unknown; valor_proposto: unknown }> };
    };
    expect(corpo.data.propostas.map((p) => p.campo)).toEqual(["cpf", "hotel"]);
    expect(corpo.data.propostas[0]).toMatchObject({ valor_atual: "111.222.333-44", valor_proposto: "999.888.777-66" });
  });

  it("não admin e as chaves restritas ilegíveis: 500, nunca a lista inteira", async () => {
    monta("agent");
    deps.client.mockResolvedValue(
      cliente({
        crm_leads: certo({ id: LEAD, pipeline_id: "p1", custom_fields: {} }),
        crm_pipelines: { data: null, error: { message: "fora do ar" } },
        custom_field_definitions: certo([]),
        lead_field_proposals: certo([linha("a", "cpf", "999.888.777-66")]),
      }),
    );
    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("999.888.777-66");
  });
});
