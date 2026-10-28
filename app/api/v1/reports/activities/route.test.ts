import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

// Só as FRONTEIRAS são simuladas (sessão, banco, service role). A regra — Zod,
// membro da organização conferido, `p_user` só repassado quando válido — é a da
// rota de verdade.
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: vi.fn(() => true) }));

const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const ROSANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INGRID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DE_OUTRA_ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVOGADA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Row = Record<string, unknown>;

const VINCULOS: Row[] = [
  { organization_id: ORG_A, user_id: ROSANA, revoked_at: null },
  { organization_id: ORG_A, user_id: INGRID, revoked_at: null },
  { organization_id: ORG_A, user_id: REVOGADA, revoked_at: "2026-10-01T00:00:00Z" },
  { organization_id: ORG_B, user_id: DE_OUTRA_ORG, revoked_at: null },
];

/** Banco mínimo que APLICA `eq` e `is null` — é o que faz o isolamento valer. */
function fakeDb(rpc: ReturnType<typeof vi.fn>) {
  function from(table: string) {
    const filtros: Array<(r: Row) => boolean> = [];
    const builder = {
      select: () => builder,
      eq: (c: string, v: unknown) => {
        filtros.push((r) => r[c] === v);
        return builder;
      },
      is: (c: string, v: unknown) => {
        filtros.push((r) => r[c] === v);
        return builder;
      },
      maybeSingle: async () => {
        const fonte = table === "user_organizations" ? VINCULOS : [];
        return { data: fonte.find((r) => filtros.every((f) => f(r))) ?? null, error: null };
      },
    };
    return builder;
  }
  return {
    from,
    rpc,
    auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: null } })) } },
  };
}

function pedido(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/reports/activities${qs}`);
}

const RELATORIO_VAZIO = {
  total: 0,
  by_actor: [],
  by_type: [],
  daily: [],
  items: [],
  items_truncated: false,
};

let rpc: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rpc = vi.fn(async () => ({ data: RELATORIO_VAZIO, error: null }));
  const db = fakeDb(rpc);
  vi.mocked(createClient).mockResolvedValue(db as never);
  vi.mocked(createAdminClient).mockReturnValue(db as never);
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG_A } } as never);
});

describe("GET /api/v1/reports/activities — filtro por atendente", () => {
  it("sem ?atendente a função é chamada sem p_user (Todos, como antes)", async () => {
    const res = await GET(pedido("?days=7"));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_org).toBe(ORG_A);
    expect("p_user" in args).toBe(false);
  });

  it("com um membro da organização, repassa p_user à função", async () => {
    const res = await GET(pedido(`?days=7&atendente=${INGRID}`));
    expect(res.status).toBe(200);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_user).toBe(INGRID);
    expect(args.p_org).toBe(ORG_A);
  });

  it("atendente vazio (?atendente=) vale como Todos", async () => {
    const res = await GET(pedido("?atendente="));
    expect(res.status).toBe(200);
    expect("p_user" in (rpc.mock.calls[0]?.[1] as Record<string, unknown>)).toBe(false);
  });

  it("recusa 422 o que não é UUID, sem chegar ao banco", async () => {
    const res = await GET(pedido("?atendente=nao-e-uuid"));
    expect(res.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("recusa 422 usuário de OUTRA organização, sem chamar a função", async () => {
    const res = await GET(pedido(`?atendente=${DE_OUTRA_ORG}`));
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("validation_failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("recusa 422 membro com vínculo revogado", async () => {
    const res = await GET(pedido(`?atendente=${REVOGADA}`));
    expect(res.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a organização vem da sessão: o mesmo UUID passa numa org e falha na outra", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG_B } } as never);
    expect((await GET(pedido(`?atendente=${ROSANA}`))).status).toBe(422);
    expect((await GET(pedido(`?atendente=${DE_OUTRA_ORG}`))).status).toBe(200);
  });
});
