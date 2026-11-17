/**
 * 1015 — aceitar uma proposta: o valor gravado só volta na resposta para administrador. A gravação
 * em si acontece para todos (é a porta de edição). Dublês: sessão, Supabase, a porta de edição e o
 * audit; o recorte e a leitura das chaves restritas são o código real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), client: vi.fn(), grava: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ updateLeadHandler: deps.grava }));

import { POST } from "./route";

const LEAD = "33333333-3333-4333-8333-333333333333";
const PID = "44444444-4444-4444-8444-444444444444";
const ctx = { params: Promise.resolve({ id: LEAD, pid: PID }) };
const req = () =>
  new NextRequest(`http://localhost/api/v1/leads/${LEAD}/field-proposals/${PID}`, {
    method: "POST",
    body: JSON.stringify({ decision: "accept" }),
  });

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
const proposta = (campo: string, valor: string) => ({
  id: PID,
  lead_id: LEAD,
  campo,
  valor_proposto: valor,
  status: "pending",
  expires_at: "2099-01-01T00:00:00Z",
  attachment_id: null,
});

function monta(role: string, campo: string, valor: string) {
  deps.role.mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org", role } });
  deps.client.mockResolvedValue(
    cliente({
      lead_field_proposals: certo(proposta(campo, valor)),
      crm_leads: certo({ id: LEAD, pipeline_id: "p1" }),
      crm_pipelines: certo([FUNIL]),
      custom_field_definitions: certo([]),
    }),
  );
  deps.grava.mockResolvedValue({});
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/leads/:id/field-proposals/:pid (accept) — campo restrito (1015)", () => {
  it.each(["agent", "manager"])("%s: grava, mas a resposta sai sem valor", async (role) => {
    monta(role, "cpf", "999.888.777-66");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const texto = await res.text();
    const corpo = JSON.parse(texto) as { data: Record<string, unknown> };
    expect(corpo.data).toEqual({ decision: "accepted", campo: "cpf" });
    expect(texto).not.toContain("999.888.777-66");
    expect(deps.grava).toHaveBeenCalledTimes(1);
  });

  it("admin: recebe o valor gravado", async () => {
    monta("admin", "cpf", "999.888.777-66");
    const res = await POST(req(), ctx);
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data).toEqual({ decision: "accepted", campo: "cpf", valor: "999.888.777-66" });
  });

  it("não admin, campo público: o valor volta normalmente", async () => {
    monta("agent", "hotel", "Mar Azul");
    const res = await POST(req(), ctx);
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data).toEqual({ decision: "accepted", campo: "hotel", valor: "Mar Azul" });
  });

  it("não admin e as chaves restritas ilegíveis: 500, e o valor não sai", async () => {
    monta("agent", "hotel", "Mar Azul");
    deps.client.mockResolvedValue(
      cliente({
        lead_field_proposals: certo(proposta("hotel", "Mar Azul")),
        crm_leads: certo({ id: LEAD, pipeline_id: "p1" }),
        crm_pipelines: certo([FUNIL]),
        custom_field_definitions: { data: null, error: { message: "fora do ar" } },
      }),
    );
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("Mar Azul");
  });
});
