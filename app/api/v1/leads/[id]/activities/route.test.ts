import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

// Só as FRONTEIRAS são simuladas (sessão, banco, audit). A regra — Zod, data no
// futuro, organização conferida contra o negócio, contact_id vindo do negócio,
// linha gravada — é a da rota de verdade.
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const LEAD_A = "44444444-4444-4444-8444-444444444444";
const LEAD_A_SEM_CONTATO = "55555555-5555-4555-8555-555555555555";
const LEAD_B = "66666666-6666-4666-8666-666666666666";
const CONTATO_A = "77777777-7777-4777-8777-777777777777";

type Row = Record<string, unknown>;

/**
 * Banco mínimo que APLICA os filtros `eq` — é o que faz o teste de isolamento
 * valer: o negócio da outra organização só some se a rota o filtrar.
 */
function fakeDb() {
  const tables: Record<string, Row[]> = {
    crm_leads: [
      { id: LEAD_A, organization_id: ORG_A, contact_id: CONTATO_A },
      { id: LEAD_A_SEM_CONTATO, organization_id: ORG_A, contact_id: null },
      { id: LEAD_B, organization_id: ORG_B, contact_id: null },
    ],
    crm_lead_activities: [],
  };
  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let pending: Row | null = null;
    const rows = () => (tables[table] ??= []);
    const builder = {
      select: () => builder,
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return builder;
      },
      insert: (row: Row) => {
        pending = {
          id: "99999999-9999-4999-8999-999999999999",
          created_at: "2026-10-19T12:00:00.000Z",
          performed_at: "2026-10-19T12:00:00.000Z",
          ...row,
        };
        rows().push(pending);
        return builder;
      },
      maybeSingle: async () => ({
        data: rows().find((r) => filters.every(([c, v]) => r[c] === v)) ?? null,
        error: null,
      }),
      single: async () => ({ data: pending, error: pending ? null : { message: "sem linha" } }),
    };
    return builder;
  }
  return { client: { from } as never, tables };
}

let db: ReturnType<typeof fakeDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = fakeDb();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_A },
  } as never);
  vi.mocked(createClient).mockResolvedValue(db.client);
});

function chama(leadId: string, body: unknown) {
  const req = new NextRequest(`http://localhost/api/v1/leads/${leadId}/activities`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return POST(req, { params: Promise.resolve({ id: leadId }) });
}

describe("POST /api/v1/leads/[id]/activities", () => {
  it("o corpo não escolhe organização nem contato: chave desconhecida é 422", async () => {
    const res = await chama(LEAD_A, {
      subtype: "ligacao",
      text: "x",
      organization_id: ORG_B,
      contact_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(res.status).toBe(422);
    expect(db.tables.crm_lead_activities).toHaveLength(0);
  });

  it("grava a atividade com o contato DO NEGÓCIO, o autor da sessão e a data escolhida", async () => {
    const ok = await chama(LEAD_A, {
      subtype: "ligacao",
      text: "  Ligou, pediu proposta  ",
      occurred_at: "2026-10-01T13:30:00.000Z",
    });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("x-request-id")).toBeTruthy();
    expect(db.tables.crm_lead_activities).toHaveLength(1);
    expect(db.tables.crm_lead_activities![0]).toMatchObject({
      organization_id: ORG_A,
      lead_id: LEAD_A,
      contact_id: CONTATO_A,
      type: "note",
      source_module: "manual",
      actor_kind: "user",
      performed_by_user_id: USER_ID,
      performed_at: "2026-10-01T13:30:00.000Z",
      payload: { subtype: "ligacao", text: "Ligou, pediu proposta" },
    });
  });

  it("sem data, grava 'agora' (não envia performed_at: vale o default do banco)", async () => {
    const res = await chama(LEAD_A, { subtype: "nota", text: "Anotação" });
    expect(res.status).toBe(201);
    const linha = db.tables.crm_lead_activities![0]!;
    // O fake só põe o default quando a rota NÃO manda `performed_at`.
    expect(linha.performed_at).toBe("2026-10-19T12:00:00.000Z");
  });

  it("negócio sem contato grava contact_id nulo", async () => {
    const res = await chama(LEAD_A_SEM_CONTATO, { subtype: "nota", text: "x" });
    expect(res.status).toBe(201);
    expect(db.tables.crm_lead_activities![0]!.contact_id).toBeNull();
  });

  it("ISOLAMENTO: negócio de OUTRA organização é 404 e nada é gravado", async () => {
    const res = await chama(LEAD_B, { subtype: "nota", text: "invasão" });
    expect(res.status).toBe(404);
    expect(db.tables.crm_lead_activities).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("negócio inexistente também é 404", async () => {
    const res = await chama("88888888-8888-4888-8888-888888888888", { subtype: "nota", text: "x" });
    expect(res.status).toBe(404);
  });

  it("recusa data no futuro (422) e não grava", async () => {
    const amanha = new Date(Date.now() + 24 * 3600_000).toISOString();
    const res = await chama(LEAD_A, { subtype: "reuniao", text: "x", occurred_at: amanha });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("occurred_at_in_future");
    expect(db.tables.crm_lead_activities).toHaveLength(0);
  });

  it("aceita 'agora' do navegador alguns segundos à frente do servidor", async () => {
    const quaseAgora = new Date(Date.now() + 30_000).toISOString();
    const res = await chama(LEAD_A, { subtype: "nota", text: "x", occurred_at: quaseAgora });
    expect(res.status).toBe(201);
  });

  it.each([
    ["texto vazio", { subtype: "nota", text: "   " }],
    ["texto com 2001 caracteres", { subtype: "nota", text: "a".repeat(2001) }],
    ["subtipo fora da lista", { subtype: "fax", text: "x" }],
    ["data que não é ISO", { subtype: "nota", text: "x", occurred_at: "ontem" }],
    ["sem subtipo", { text: "x" }],
  ])("recusa %s com 422", async (_nome, corpo) => {
    const res = await chama(LEAD_A, corpo);
    expect(res.status).toBe(422);
    expect(db.tables.crm_lead_activities).toHaveLength(0);
  });

  it("aceita exatamente 2000 caracteres", async () => {
    const res = await chama(LEAD_A, { subtype: "nota", text: "a".repeat(2000) });
    expect(res.status).toBe(201);
  });

  it("exige papel agent (viewer é barrado antes de qualquer efeito)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }),
    } as never);
    const res = await chama(LEAD_A, { subtype: "nota", text: "x" });
    expect(res.status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("agent");
    expect(db.tables.crm_lead_activities).toHaveLength(0);
  });

  it("acompanhamento de suporte somente-leitura é barrado ANTES do efeito", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }) as never,
    );
    const res = await chama(LEAD_A, { subtype: "nota", text: "x" });
    expect(res.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(db.tables.crm_lead_activities).toHaveLength(0);
  });

  it("audita sem o texto: subtipo, tamanho e se foi retroativo", async () => {
    await chama(LEAD_A, {
      subtype: "email",
      text: "dado sensível do cliente",
      occurred_at: "2026-10-01T10:00:00.000Z",
    });
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "lead.activity_logged",
      organizationId: ORG_A,
      actorUserId: USER_ID,
      resourceType: "crm_lead",
      resourceId: LEAD_A,
    });
    expect(entrada.metadata).toMatchObject({ subtype: "email", backdated: true });
    expect(JSON.stringify(entrada.metadata)).not.toContain("dado sensível");
  });

  it("'agora' do navegador até 5 min adiantado grava now() do servidor (não o instante adiantado)", async () => {
    const adiantado = new Date(Date.now() + 120_000).toISOString();
    const res = await chama(LEAD_A, { subtype: "nota", text: "x", occurred_at: adiantado });
    expect(res.status).toBe(201);
    const linha = db.tables.crm_lead_activities![0]!;
    // Sem `performed_at` na linha enviada o default do banco (now()) é que vale.
    expect(linha.performed_at).toBe("2026-10-19T12:00:00.000Z");
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toMatchObject({ backdated: false });
  });

  it("recusa data anterior a 2000-01-01 (422)", async () => {
    const res = await chama(LEAD_A, { subtype: "nota", text: "x", occurred_at: "1999-12-31T23:59:59.000Z" });
    expect(res.status).toBe(422);
    expect(db.tables.crm_lead_activities).toHaveLength(0);
  });

  it("id que não é UUID é 404 e não passa pela autorização nem pelo banco", async () => {
    const res = await chama("nao-e-uuid", { subtype: "nota", text: "x" });
    expect(res.status).toBe(404);
    expect(db.tables.crm_lead_activities).toHaveLength(0);
  });
});
