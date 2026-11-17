/**
 * 1015 — roteiros do contato: a pergunta que grava em campo NÃO PÚBLICO sai inteira (chave, rótulo e
 * valor) para quem não é administrador. Dublês: só a fronteira (sessão, Supabase, módulo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));

import { GET } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: ID }) };
const req = () => new NextRequest(`http://localhost/api/v1/contacts/${ID}/roteiros`);

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
const coleta = (id: string, key: string, label: string) => ({
  id,
  type: "collect",
  label,
  position: { x: 0, y: 0 },
  config: { key, label, type: "text", required: true, permite_correcao: true },
});
const grafo = {
  nodes: [
    { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    coleta("c1", "nome_completo", "Nome completo"),
    coleta("c2", "cpf", "CPF"),
    { id: "e", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "a", source: "t", target: "c1", priority: 0, condition: { type: "always" } },
    { id: "b", source: "c1", target: "c2", priority: 0, condition: { type: "always" } },
    { id: "c", source: "c2", target: "e", priority: 0, condition: { type: "always" } },
  ],
};

function monta(role: string, definicoes: unknown[] = [{ key: "CPF" }]) {
  deps.role.mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org", role } });
  deps.client.mockResolvedValue(
    cliente({
      contacts: certo({ id: ID, custom_fields: { nome_completo: "Lia Mendes", cpf: "111.222.333-44" }, is_anonymized: false }),
      followup_enrollments: certo([
        {
          id: "e1",
          status: "completed",
          started_at: "2026-09-24T10:00:00Z",
          completed_at: "2026-09-24T10:05:00Z",
          followup_flow_pointers: { name: "Cadastro", surface: "atendimento" },
          followup_flow_versions: { graph: grafo },
        },
      ]),
      custom_field_definitions: certo(definicoes),
      crm_pipelines: certo([]),
    }),
  );
}

type Corpo = { data: Array<{ campos: Array<{ key: string; valor: unknown }> }> };

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/contacts/:id/roteiros — campo restrito (1015)", () => {
  it.each(["viewer", "agent", "manager"])("%s: a pergunta do campo restrito some", async (role) => {
    monta(role);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const texto = await res.text();
    const corpo = JSON.parse(texto) as Corpo;
    expect(corpo.data[0]!.campos.map((c) => c.key)).toEqual(["nome_completo"]);
    expect(texto).not.toContain("111.222.333-44");
  });

  it("admin: vê as duas perguntas, com o valor", async () => {
    monta("admin");
    const corpo = (await (await GET(req(), ctx)).json()) as Corpo;
    expect(corpo.data[0]!.campos.map((c) => [c.key, c.valor])).toEqual([
      ["nome_completo", "Lia Mendes"],
      ["cpf", "111.222.333-44"],
    ]);
  });

  it("não admin e as chaves restritas ilegíveis: 500, sem entregar o valor", async () => {
    monta("agent");
    deps.client.mockResolvedValue(
      cliente({
        contacts: certo({ id: ID, custom_fields: { cpf: "111.222.333-44" }, is_anonymized: false }),
        followup_enrollments: certo([
          {
            id: "e1",
            status: "completed",
            started_at: "2026-09-24T10:00:00Z",
            completed_at: null,
            followup_flow_pointers: { name: "Cadastro", surface: "atendimento" },
            followup_flow_versions: { graph: grafo },
          },
        ]),
        custom_field_definitions: { data: null, error: { message: "fora do ar" } },
        crm_pipelines: certo([]),
      }),
    );
    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("111.222.333-44");
  });
});
