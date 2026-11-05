/**
 * GET /admin/tenants/[id]/exclusao — Hiperbold: a tela pergunta se a régua de cobrança libera a exclusão. A guarda
 * de admin da plataforma roda de verdade (só o que ela consulta é substituído), e a régua lê um banco falso.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linhaDoAdmin: null as Record<string, unknown> | null,
  contrato: null as { status: string } | null,
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false, mfaEmDividaEstrita: async () => false }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "aaaaaaaa-0000-4000-8000-000000000001" } } }),
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
      c.maybeSingle = async () => {
        if (tabela === "billing_contracts") {
          return {
            data: h.contrato && {
              ...h.contrato,
              cycle: "mensal",
              current_period_end: "2026-11-01T03:00:00.000Z",
              billing_plans: null,
            },
            error: null,
          };
        }
        if (tabela === "billing_settings") return { data: { modo: "avisar" }, error: null };
        return { data: null, error: { message: `tabela inesperada: ${tabela}` } };
      };
      return c;
    },
    rpc: async () => ({ data: false, error: null }),
  }),
}));

import { GET } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const ctx = (id = TENANT) => ({ params: Promise.resolve({ id }) });
const pedido = () => new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/exclusao`);

beforeEach(() => {
  h.linhaDoAdmin = { user_id: "aaaaaaaa-0000-4000-8000-000000000001", scope: "full", mfa_required: false, revoked_at: null };
  h.contrato = null;
});

describe("GET /admin/tenants/[id]/exclusao", () => {
  it("contrato suspenso pela régua: liberada false com a mensagem", async () => {
    h.contrato = { status: "suspensa" };
    const res = await GET(pedido(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      liberada: false,
      codigo: "exclusao_na_regua_de_cobranca",
      mensagem: "Esta empresa está na régua de cobrança; a exclusão só é liberada quando a régua termina.",
      estado: "suspensa",
    });
  });

  it("contrato cancelado: liberada", async () => {
    h.contrato = { status: "cancelada" };
    const res = await GET(pedido(), ctx());
    expect((await res.json()).data).toEqual({ liberada: true });
  });

  it("id que não é uuid: 404", async () => {
    const res = await GET(pedido(), ctx("nao-e-uuid"));
    expect(res.status).toBe(404);
  });

  it("quem não é admin da plataforma: 403, sem resposta da régua", async () => {
    h.linhaDoAdmin = null;
    const res = await GET(pedido(), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).data).toBeUndefined();
  });
});
