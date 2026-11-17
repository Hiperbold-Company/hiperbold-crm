/**
 * GET /api/v1/channels/conexoes por token `Authorization: Bearer dsk_…` — a porta REAL
 * (`autorizarAdministracao` + `resolveAuthDual`), sem dublê dela. Só a borda é falsa: o autenticador do
 * token, a sessão e o banco.
 *
 * A lista de conexões é leitura de administração (piso `manager`, o da tela): o token precisa do escopo
 * `mcp:read` E de papel que alcance `manager`. Chave sem leitura, ou de papel `agent`, é recusada antes de
 * qualquer consulta ao banco.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import type { Role } from "@/lib/auth/types";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/billing/planos/limites-com-cache-curto", () => ({
  limitesComCacheCurto: vi.fn(async () => ({ limites: {}, leituraFalhou: false })),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  peekRateLimit: vi.fn(async () => 0),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return { ...real, validateBearerToken: vi.fn() };
});

const ORG_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DONO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const URL_DA_LISTA = "http://localhost/api/v1/channels/conexoes";

/** Banco falso: registra cada `.eq()` e devolve uma conexão oficial viva da organização do token. */
function bancoFalso() {
  const consultas: Array<Record<string, unknown>> = [];
  const from = () => {
    const filtros: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: unknown) => ((filtros[c] = v), chain),
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
        consultas.push({ ...filtros });
        return Promise.resolve({
          data: [
            {
              id: "aaaaaaaa-0000-4000-8000-0000000000a1",
              provider: "meta",
              status: "WORKING",
              display_name: "Loja",
              phone_number: "+5511911111111",
              meta_waba_id: "900000000000001",
              meta_phone_number_id: "111111111111111",
              created_at: "2026-10-01T00:00:00.000Z",
            },
          ],
          error: null,
        }).then(ok, ko);
      },
    };
    return chain;
  };
  return { from, consultas };
}

function comoToken(role: Role, scopes: string[]) {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_TOKEN,
    role,
    actor: { type: "api_token", id: TOKEN_ID, role },
    apiTokenId: TOKEN_ID,
    scopes: [...scopes, `role:${role}`],
    createdBy: DONO,
  } as never);
}

const pedir = () =>
  new NextRequest(URL_DA_LISTA, { headers: { authorization: "Bearer dsk_teste_segredo" } });

beforeEach(() => {
  vi.clearAllMocks();
  // Sem Bearer a porta cairia na sessão; aqui a sessão é "ninguém logado".
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: { code: "unauthenticated" } }), { status: 401 }),
  } as never);
});

describe("GET /channels/conexoes por token — porta real", () => {
  it("token SEM o escopo mcp:read é recusado (403) e o banco nem é consultado", async () => {
    const db = bancoFalso();
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    // `mcp:write` sozinho não dá leitura: o escopo de escrita não implica o de leitura.
    comoToken("manager", ["mcp:write"]);
    const { GET } = await import("@/app/api/v1/channels/conexoes/route");

    const res = await GET(pedir());
    expect(res.status).toBe(403);
    expect(db.consultas).toHaveLength(0);
  });

  it("token de papel agent, mesmo com mcp:read, é recusado (403): o piso da lista é manager", async () => {
    const db = bancoFalso();
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("agent", ["mcp:read"]);
    const { GET } = await import("@/app/api/v1/channels/conexoes/route");

    const res = await GET(pedir());
    expect(res.status).toBe(403);
    expect(db.consultas).toHaveLength(0);
  });

  it("controle: manager + mcp:read passa, e a consulta é da organização DO TOKEN", async () => {
    const db = bancoFalso();
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:read"]);
    const { GET } = await import("@/app/api/v1/channels/conexoes/route");

    const res = await GET(pedir());
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ tipo: string }> };
    expect(data).toHaveLength(1);
    expect(db.consultas.length).toBeGreaterThan(0);
    expect(db.consultas.every((c) => c.organization_id === ORG_TOKEN)).toBe(true);
  });
});
