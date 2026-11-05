import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { mfaEmDividaEstrita } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Achado da auditoria: esta rota escrevia em `incidents` (resolução) só com
 * `requirePlatformAdmin()`, que aceita QUALQUER escopo. Um admin
 * `support_readonly` resolvia incidentes de qualquer organização. O portão
 * de escopo segue o mesmo padrão de `POST /api/v1/admin/tenants`.
 */

// O portão real (`requirePlatformAdminEscrita`) roda: só a sessão e a linha de
// `platform_admins` vêm do dublê, e a dívida de MFA estrita é o interruptor.
const sessao = vi.hoisted(() => ({ scope: "full" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const consulta: Record<string, unknown> = {};
    consulta.select = () => consulta;
    consulta.eq = () => consulta;
    consulta.is = () => consulta;
    consulta.maybeSingle = async () => ({
      data: { user_id: ADMIN_ID, scope: sessao.scope, mfa_required: false, revoked_at: null },
      error: null,
    });
    return {
      auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID, factors: [] } } }) },
      from: () => consulta,
    };
  },
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDividaEstrita: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const INCIDENT_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function incidentsBuilder() {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.update = () => builder;
  builder.maybeSingle = async () => ({
    data: {
      id: INCIDENT_ID,
      status: "open",
      organization_id: ORG_ID,
      type: "billing",
      severity: "high",
    },
    error: null,
  });
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ error: null }).then(resolve);
  return builder;
}

function makeAdminStub() {
  return {
    from: (table: string) =>
      table === "incidents" ? incidentsBuilder() : { insert: () => Promise.resolve({ error: null }) },
  };
}

function request() {
  return new NextRequest(`http://localhost/api/v1/admin/incidents/${INCIDENT_ID}/resolve`, {
    method: "POST",
    body: JSON.stringify({ resolution_note: "Corrigido junto ao provedor" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  sessao.scope = "full";
  vi.mocked(mfaEmDividaEstrita).mockResolvedValue(false);
  vi.mocked(createAdminClient).mockReturnValue(makeAdminStub() as never);
});

describe("POST /api/v1/admin/incidents/[id]/resolve", () => {
  it("admin com escopo support_readonly é recusado antes de qualquer escrita", async () => {
    sessao.scope = "support_readonly";
    const { POST } = await import("./route");

    const res = await POST(request(), { params: Promise.resolve({ id: INCIDENT_ID }) });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    // O portão comum da escrita (upstream) nomeia a recusa de escopo.
    expect(body.error.code).toBe("forbidden_scope");
  });

  it("admin com escopo full e MFA em dia consegue resolver", async () => {
    const { POST } = await import("./route");

    const res = await POST(request(), { params: Promise.resolve({ id: INCIDENT_ID }) });

    expect(res.status).toBe(200);
  });

  it("admin com escopo full mas MFA em dívida é recusado", async () => {
    vi.mocked(mfaEmDividaEstrita).mockResolvedValue(true);
    const { POST } = await import("./route");

    const res = await POST(request(), { params: Promise.resolve({ id: INCIDENT_ID }) });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("mfa_required");
  });
});
