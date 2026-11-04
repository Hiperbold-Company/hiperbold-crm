/**
 * D-091: a organização suspensa pela plataforma continuava operando pela API.
 *
 * O único portão era o layout de `/app` (redirect para /account-suspended); a
 * rota `/api/v1/*` com o cookie e o bearer `dsk_` seguiam respondendo. Agora:
 *  - `requireRole` recusa 403 `org_suspended` (código do upstream, que substituiu o
 *    nosso `tenant_suspended`) para membro de organização suspensa, em qualquer papel;
 *  - desde o upstream nem o admin de plataforma passa pelo atalho `allowPlatformAdmin`
 *    em org parada: só a rota que declara `permiteOrgSuspensa` (LGPD, cobrança). A
 *    reativação tem portão próprio (`requirePlatformAdminEscrita`), que não depende da org;
 *  - `resolveApiToken` recusa o token de organização suspensa (`org_suspended`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, orgAtivaSemPortao, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiTokenError, McpAuthError, resolveApiToken, validateBearerToken } from "@/lib/mcp/auth";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  mfaEmDividaEstrita: vi.fn(async () => false),
  sessionAal: vi.fn(async () => "aal2"),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/rate-limit", () => ({
  registrarFalhaDeToken: vi.fn(async () => undefined),
  tokenFailureLimited: vi.fn(async () => false),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function sessao(status: string | undefined, role: Role = "admin", platformAdmin = false) {
  const user: AuthUser = {
    id: USER_ID,
    email: "u@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: platformAdmin,
    ...(platformAdmin ? { platform_admin_scope: "full" as const } : {}),
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role, org_status: status }],
  };
  const ativa = { orgId: ORG_ID, name: "Org", role, org_status: status };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue(ativa);
  vi.mocked(orgAtivaSemPortao).mockResolvedValue(ativa);
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async () => ({ data: role, error: null })),
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: platformAdmin ? { scope: "full" } : null, error: null });
      return b;
    },
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("D-091 requireRole", () => {
  it("organização suspensa: 403 org_suspended, mesmo para admin", async () => {
    sessao("suspended");
    const r = await requireRole("viewer");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(403);
    expect((await r.response.json()).error.code).toBe("org_suspended");
  });

  it("organização arquivada ou anonimizada também é recusada", async () => {
    for (const status of ["archived", "redacted"]) {
      sessao(status);
      const r = await requireRole("viewer");
      expect(r.ok, status).toBe(false);
    }
  });

  it("organização ativa passa; status ausente falha FECHADO (regra do upstream)", async () => {
    sessao("active");
    expect((await requireRole("viewer")).ok).toBe(true);
    sessao(undefined);
    expect((await requireRole("viewer")).ok).toBe(false);
  });

  it("admin de plataforma full: em rota comum também é recusado; com `permiteOrgSuspensa` entra", async () => {
    sessao("suspended", "admin", true);
    const comum = await requireRole("admin", { allowPlatformAdmin: true, organizationId: ORG_ID });
    expect(comum.ok).toBe(false);
    const declarada = await requireRole("admin", {
      allowPlatformAdmin: true,
      organizationId: ORG_ID,
      permiteOrgSuspensa: true,
    });
    expect(declarada.ok).toBe(true);
  });

  it("o override organizationId também respeita a suspensão do membro", async () => {
    sessao("suspended");
    const r = await requireRole("viewer", { organizationId: ORG_ID });
    expect(r.ok).toBe(false);
  });
});

function adminDeTokens(linha: Record<string, unknown>) {
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      if (tabela === "api_tokens") {
        c.select = () => c;
        c.eq = () => c;
        c.maybeSingle = async () => ({ data: linha, error: null });
        // `update(...).eq(...)` com quantos filtros a escrita do `last_used_at` encadear.
        const escrita: Record<string, unknown> = {
          then: (r: (v: unknown) => unknown) => r({ error: null }),
        };
        for (const m of ["eq", "is", "or", "lt"]) escrita[m] = () => escrita;
        c.update = () => escrita;
        return c;
      }
      // user_organizations / platform_admins do criador: sempre em dia aqui.
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: { role: "admin", user_id: USER_ID }, error: null });
      return c;
    },
  } as never);
}

const PLAINTEXT = "dsk_abcd_segredo";

function linha(statusDaOrg: string | undefined) {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    organization_id: ORG_ID,
    scopes: ["mcp:read", "role:agent"],
    revoked_at: null,
    expires_at: null,
    created_by: USER_ID,
    organizations: statusDaOrg ? { status: statusDaOrg } : null,
  };
}

describe("D-091 token de API", () => {
  it("token de organização suspensa: recusa com reason org_suspended", async () => {
    adminDeTokens(linha("suspended"));
    await expect(resolveApiToken(PLAINTEXT)).rejects.toMatchObject({
      name: "ApiTokenError",
      reason: "org_suspended",
    });
  });

  it("pela casca MCP: 403 org_suspended, sem debitar o teto de falhas (correção do upstream)", async () => {
    // Nossa auditoria de 17/10/2026 (achado baixo 5) tinha tornado esta recusa a
    // mesma 401 neutra de token inválido. O upstream (7be5cdb653) decidiu de
    // propósito o contrário: o token é VÁLIDO (quem chuta não chega aqui), então
    // a resposta diz 403 `org_suspended` e não debita o balde — senão a integração
    // do cliente ficava trancada por minutos depois da reativação. Na junção,
    // a correção do upstream vence.
    adminDeTokens(linha("suspended"));
    const erro = await validateBearerToken(`Bearer ${PLAINTEXT}`).catch((e) => e);
    expect(erro).toBeInstanceOf(McpAuthError);
    expect(erro.httpStatus).toBe(403);
    expect(erro.mcpCode).toBe(-32002);
    expect(erro.codigo).toBe("org_suspended");
  });

  it("organização ativa: token resolve", async () => {
    adminDeTokens(linha("active"));
    const r = await resolveApiToken(PLAINTEXT);
    expect(r.organizationId).toBe(ORG_ID);
  });

  it("ApiTokenError é exportada com o reason novo", () => {
    expect(new ApiTokenError("org_suspended", "x").reason).toBe("org_suspended");
  });
});
