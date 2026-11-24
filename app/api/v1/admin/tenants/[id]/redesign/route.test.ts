import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/admin/tenants/[id]/redesign — liga/desliga o novo visual de UMA
 * empresa. Só admin da plataforma com escrita (scope full + MFA), empresa pelo
 * caminho (nunca pelo corpo), uma chave de settings pela função do banco
 * (`fn_atualizar_setting_da_organizacao`), auditoria quando mudou.
 */

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  linhaDoAdmin: null as Record<string, unknown> | null,
  org: null as Record<string, unknown> | null,
  suporteNega: null as Response | null,
  escritasDiretas: [] as string[],
  rpc: vi.fn(),
  audit: vi.fn(),
  invalidar: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => h.suporteNega }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false, mfaEmDividaEstrita: async () => false }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/auth/cache-curto", () => ({ invalidarOrg: h.invalidar }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: h.ator } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: h.linhaDoAdmin, error: null });
      return c;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => ({ data: h.org, error: null });
      c.insert = () => (h.escritasDiretas.push(tabela), c);
      c.update = () => (h.escritasDiretas.push(tabela), c);
      c.upsert = () => (h.escritasDiretas.push(tabela), c);
      return c;
    },
    rpc: (...args: unknown[]) => h.rpc(...args),
  }),
}));

import { POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ id: TENANT }) };
const pedido = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/redesign`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const admin = (scope: string) => ({ user_id: h.ator, scope, mfa_required: false, revoked_at: null });

beforeEach(() => {
  vi.clearAllMocks();
  h.linhaDoAdmin = admin("full");
  h.org = { id: TENANT, slug: "acme", settings: {} };
  h.suporteNega = null;
  h.escritasDiretas = [];
  h.rpc.mockResolvedValue({ data: 1, error: null });
});

describe("POST /admin/tenants/[id]/redesign", () => {
  it("admin full liga: grava só settings.redesign pela função do banco, audita e invalida o cache", async () => {
    const res = await POST(pedido({ ligado: true }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.ligado).toBe(true);

    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = h.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("fn_atualizar_setting_da_organizacao");
    expect(args.p_org).toBe(TENANT);
    expect(args.p_caminho).toEqual(["redesign"]);
    expect((args.p_valor as Record<string, unknown>).ligado).toBe(true);
    expect((args.p_valor as Record<string, unknown>).alterado_por).toBe(h.ator);

    expect(h.escritasDiretas).toEqual([]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const auditoria = h.audit.mock.calls[0][0] as Record<string, unknown>;
    expect(auditoria.action).toBe("tenant.redesign_changed");
    expect(auditoria.organizationId).toBe(TENANT);
    expect(auditoria.actorUserId).toBe(h.ator);
    expect(auditoria.actingAsPlatformAdmin).toBe(true);
    expect(h.invalidar).toHaveBeenCalledWith(TENANT);
  });

  it("desligar também grava e audita", async () => {
    h.org = { id: TENANT, slug: "acme", settings: { redesign: { ligado: true } } };
    const res = await POST(pedido({ ligado: false }), ctx);
    expect(res.status).toBe(200);
    const [, args] = h.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect((args.p_valor as Record<string, unknown>).ligado).toBe(false);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it("pedir o estado que já está: 200 sem gravar nem auditar", async () => {
    h.org = { id: TENANT, slug: "acme", settings: { redesign: { ligado: true } } };
    const res = await POST(pedido({ ligado: true }), ctx);
    expect(res.status).toBe(200);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("support_readonly: 403 forbidden_scope, nada gravado", async () => {
    h.linhaDoAdmin = admin("support_readonly");
    const res = await POST(pedido({ ligado: true }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("quem não é admin da plataforma: recusado, nada gravado", async () => {
    h.linhaDoAdmin = null;
    const res = await POST(pedido({ ligado: true }), ctx).catch((e: Error) => e);
    if (res instanceof Error) expect(res.message).toMatch(/redirect:/);
    else expect(res.status).toBeGreaterThanOrEqual(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("sessão de suporte sem escrita: a guarda de suporte responde e nada é gravado", async () => {
    h.suporteNega = new Response(JSON.stringify({ error: { code: "support_readonly" } }), { status: 403 });
    const res = await POST(pedido({ ligado: true }), ctx);
    expect(res.status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["corpo vazio", {}],
    ["ligado como texto", { ligado: "true" }],
    ["chave a mais (organization_id no corpo)", { ligado: true, organization_id: "outra" }],
  ])("%s → 400 validation_failed, nada gravado", async (_nome, corpo) => {
    const res = await POST(pedido(corpo), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_failed");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("empresa inexistente → 404, nada gravado", async () => {
    h.org = null;
    const res = await POST(pedido({ ligado: true }), ctx);
    expect(res.status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("falha do banco ao gravar → 500, sem auditoria", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "fora" } });
    const res = await POST(pedido({ ligado: true }), ctx);
    expect(res.status).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
