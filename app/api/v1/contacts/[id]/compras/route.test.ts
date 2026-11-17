/**
 * 1015 — "Últimas compras": o campo NÃO PÚBLICO escolhido como coluna só mostra valor a
 * administrador. Papel ilegível (sem vínculo ativo) também não vê. Dublês: só a fronteira (Supabase).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));

import { GET } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: ID }) };
const req = () => new NextRequest(`http://localhost/api/v1/contacts/${ID}/compras`);

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

function monta(membro: unknown) {
  deps.client.mockResolvedValue(
    cliente({
      contacts: certo({ organization_id: "org" }),
      organizations: certo({ interface_settings: { preset: "completa", compras_campos: ["cpf", "hotel"] } }),
      crm_leads: certo([
        {
          id: "l1",
          title: "Viagem",
          status: "won",
          value_cents: 1000,
          currency: "BRL",
          closed_at: "2026-10-01T10:00:00Z",
          pipeline_id: "p1",
          custom_fields: { cpf: "111.222.333-44", hotel: "Mar Azul" },
          crm_pipelines: FUNIL,
        },
      ]),
      user_organizations: certo(membro),
      crm_pipelines: certo([FUNIL]),
      custom_field_definitions: certo([]),
    }),
  );
}

type Corpo = { data: { compras: Array<{ campos: Array<{ chave: string; valor: string }> }> } };
const chaves = (c: Corpo) => c.data.compras[0]!.campos.map((x) => x.chave);

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/contacts/:id/compras — campo restrito (1015)", () => {
  it.each(["viewer", "agent", "manager"])("%s: o campo restrito não aparece nas compras", async (role) => {
    monta({ role });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const texto = await res.text();
    expect(chaves(JSON.parse(texto) as Corpo)).toEqual(["hotel"]);
    expect(texto).not.toContain("111.222.333-44");
  });

  it("admin: vê os dois campos", async () => {
    monta({ role: "admin" });
    const corpo = (await (await GET(req(), ctx)).json()) as Corpo;
    expect(chaves(corpo)).toEqual(["cpf", "hotel"]);
  });

  it("papel não legível (sem vínculo): não vê o restrito", async () => {
    monta(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const texto = await res.text();
    expect(chaves(JSON.parse(texto) as Corpo)).toEqual(["hotel"]);
    expect(texto).not.toContain("111.222.333-44");
  });

  it("não admin e as chaves restritas ilegíveis: 500", async () => {
    monta({ role: "agent" });
    deps.client.mockResolvedValue(
      cliente({
        contacts: certo({ organization_id: "org" }),
        organizations: certo({ interface_settings: { preset: "completa", compras_campos: ["cpf"] } }),
        crm_leads: certo([
          { id: "l1", title: "V", status: "won", value_cents: 1, currency: "BRL", closed_at: "2026-10-01T10:00:00Z", pipeline_id: "p1", custom_fields: { cpf: "111.222.333-44" }, crm_pipelines: FUNIL },
        ]),
        user_organizations: certo({ role: "agent" }),
        crm_pipelines: certo([]),
        custom_field_definitions: { data: null, error: { message: "fora do ar" } },
      }),
    );
    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("111.222.333-44");
  });
});
