/**
 * D-227: o MCP e a API REST por chave `dsk_` são recursos do plano.
 *
 *  - `/api/mcp`: plano com `mcp_req_min = 0` (Pro), ou leitura do plano que
 *    falha, recusa com JSON-RPC -32002 / HTTP 403 e `data.code = plano_sem_mcp`;
 *    com valor > 0 o teto POR ORGANIZAÇÃO por minuto é o do plano e o por token
 *    vira min(60, plano);
 *  - bearer REST (`resolveAuthDual` e `GET /api/v1/contacts`): plano com
 *    `acesso_api = 0`, ou leitura que falha, é 402 `plano_sem_api`; cookie não
 *    é afetado; a trava da API não alcança o `/api/mcp`.
 *
 * Dublês só na borda: a leitura do plano no banco (`planoDaOrganizacao`), o
 * autenticador do token, a sessão e o contador de janela. As travas, o cache
 * curto e as rotas são os de verdade.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpAuthResult } from "@/lib/mcp/auth";

let limitesDoPlano: Record<string, number | null> = {};
let leituraFalha = false;
const baldes = new Map<string, number>();

vi.mock("@/lib/billing/planos/plano-da-organizacao", () => ({
  planoDaOrganizacao: vi.fn(async () => ({
    plano: { code: "x", name: "X", version: 2 },
    contrato: null,
    limites: leituraFalha ? {} : limitesDoPlano,
    leituraFalhou: leituraFalha,
  })),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ session: true })) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
// Janela fixa com a mesma semântica: conta por chave e recusa acima do limite.
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async (chave: string, limite: number) => {
    const n = (baldes.get(chave) ?? 0) + 1;
    baldes.set(chave, n);
    return { allowed: n <= limite, count: n, limit: limite, window_sec: 60, window_start: 0 };
  }),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
vi.mock("@/lib/mcp/server", () => ({
  createMcpServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) })),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ modulosLigados: vi.fn(async () => []) }));
vi.mock("@/lib/organizacao/capacidades", () => ({ capacidadesDaOrganizacao: vi.fn(async () => []) }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({
  listContactsHandler: vi.fn(async () => ({ contacts: [], cursor: null, has_more: false })),
  createContactHandler: vi.fn(),
}));

const { validateBearerToken, McpAuthError } = await import("@/lib/mcp/auth");
const { planoDaOrganizacao } = await import("@/lib/billing/planos/plano-da-organizacao");
const { requireRole } = await import("@/lib/auth/require-role");
const { createMcpServer } = await import("@/lib/mcp/server");
const { esquecerTudo } = await import("@/lib/auth/cache-curto");
const { exigirMcpNoPlano } = await import("@/lib/mcp/plano-do-mcp");
const { verificarTetoMcp } = await import("@/lib/mcp/rate-limit");
const { resolveAuthDual } = await import("@/lib/api/auth-dual");

const ORG = "22222222-2222-4222-8222-222222222222";
const PRO = { mcp_req_min: 0, acesso_api: 0, fonte_dados_req_min: 60 };
const MAX = { mcp_req_min: 30, acesso_api: 1, fonte_dados_req_min: 60 };

function authDoToken(tokenId = "tok-1"): McpAuthResult {
  return {
    organizationId: ORG,
    role: "manager",
    actor: { type: "user", id: tokenId } as never,
    apiTokenId: tokenId,
    scopes: ["mcp:read", "mcp:write", "role:manager"],
    createdBy: "11111111-1111-4111-8111-111111111111",
  };
}

function reqComBearer(url: string) {
  return new NextRequest(url, { method: "POST", headers: { authorization: "Bearer dsk_abc_def" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  esquecerTudo();
  baldes.clear();
  leituraFalha = false;
  limitesDoPlano = {};
  vi.mocked(validateBearerToken).mockResolvedValue(authDoToken());
});

describe("MCP: o plano liga e desliga o servidor", () => {
  it("⭐ Pro (mcp_req_min 0): /api/mcp recusa com -32002 / 403 e data.code plano_sem_mcp, sem montar o servidor", async () => {
    limitesDoPlano = PRO;
    const { POST } = await import("@/app/api/mcp/route");

    const res = await POST(reqComBearer("http://localhost/api/mcp"));

    expect(res.status).toBe(403);
    const corpo = (await res.json()) as { error: { code: number; message: string; data?: { code: string } } };
    expect(corpo.error.code).toBe(-32002);
    expect(corpo.error.data?.code).toBe("plano_sem_mcp");
    expect(corpo.error.message).toBe("O servidor MCP está disponível nos planos Max e Scale.");
    expect(createMcpServer).not.toHaveBeenCalled();
  });

  it("leitura do plano que falha também recusa (recurso pago nega na falha), e a falha não fica no cache", async () => {
    leituraFalha = true;
    await expect(exigirMcpNoPlano({} as never, ORG)).rejects.toMatchObject({ codigo: "plano_sem_mcp", httpStatus: 403 });
    await expect(exigirMcpNoPlano({} as never, ORG)).rejects.toBeInstanceOf(McpAuthError);
    expect(planoDaOrganizacao).toHaveBeenCalledTimes(2);

    leituraFalha = false;
    limitesDoPlano = MAX;
    await expect(exigirMcpNoPlano({} as never, ORG)).resolves.toBe(30);
  });

  it("⭐ MCP do plano que tem MCP mas não tem API não é bloqueado pela trava da API", async () => {
    limitesDoPlano = { mcp_req_min: 30, acesso_api: 0 };
    const { POST } = await import("@/app/api/mcp/route");

    const res = await POST(reqComBearer("http://localhost/api/mcp"));

    const corpo = (await res.json().catch(() => ({}))) as { error?: { data?: { code?: string } } };
    expect(corpo.error?.data?.code).not.toBe("plano_sem_mcp");
    expect(res.status).not.toBe(402);
    expect(createMcpServer).toHaveBeenCalledTimes(1);
    // O teto do plano viaja até `verificarTetoMcp`.
    expect(vi.mocked(createMcpServer).mock.calls[0]?.[0]).toMatchObject({ organizationId: ORG, mcpReqMinDoPlano: 30 });
  });

  it("a leitura do plano por requisição usa o cache curto (MCP é caminho quente)", async () => {
    limitesDoPlano = MAX;
    await exigirMcpNoPlano({} as never, ORG);
    await exigirMcpNoPlano({} as never, ORG);
    expect(planoDaOrganizacao).toHaveBeenCalledTimes(1);
  });

  it("plano sem teto de MCP (null, Ilimitado) entra sem teto do plano", async () => {
    limitesDoPlano = { mcp_req_min: null };
    await expect(exigirMcpNoPlano({} as never, ORG)).resolves.toBeNull();
  });
});

describe("MCP: o teto por minuto segue o plano", () => {
  it("⭐ Max (30): o teto por ORGANIZAÇÃO é 30, somando tokens diferentes", async () => {
    const a = { ...authDoToken("tok-a"), mcpReqMinDoPlano: 30 };
    const b = { ...authDoToken("tok-b"), mcpReqMinDoPlano: 30 };
    for (let i = 0; i < 20; i++) await verificarTetoMcp(a, "read");
    for (let i = 0; i < 10; i++) await verificarTetoMcp(b, "read");

    await expect(verificarTetoMcp(b, "read")).rejects.toThrow(/organização/);
  });

  it("o teto por token vira min(60, plano): um token do Max para no 31º", async () => {
    const a = { ...authDoToken("tok-a"), mcpReqMinDoPlano: 30 };
    for (let i = 0; i < 30; i++) await verificarTetoMcp(a, "read");
    await expect(verificarTetoMcp(a, "read")).rejects.toThrow(/\(token\)/);
  });

  it("sem teto do plano valem os fixos: 60 por token", async () => {
    const a = authDoToken("tok-a");
    for (let i = 0; i < 60; i++) await verificarTetoMcp(a, "read");
    await expect(verificarTetoMcp(a, "read")).rejects.toThrow(/\(token\)/);
  });
});

describe("API REST com chave dsk_: o plano liga e desliga", () => {
  const opcoes = { requestId: "req-1", resource: "leads", role: "viewer" as const, scope: "mcp:read" };

  it("⭐ Pro (acesso_api 0): bearer REST é 402 plano_sem_api", async () => {
    limitesDoPlano = PRO;
    const r = await resolveAuthDual(reqComBearer("http://localhost/api/v1/leads"), opcoes);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(402);
    const corpo = (await r.response.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("plano_sem_api");
    expect(corpo.error.message).toBe("A API com chave de acesso está disponível nos planos Max e Scale.");
  });

  it("leitura do plano que falha também é 402", async () => {
    leituraFalha = true;
    const r = await resolveAuthDual(reqComBearer("http://localhost/api/v1/leads"), opcoes);
    expect(r.ok ? 200 : r.response.status).toBe(402);
  });

  it("Max (acesso_api 1): bearer REST passa, com a organização do token", async () => {
    limitesDoPlano = MAX;
    const r = await resolveAuthDual(reqComBearer("http://localhost/api/v1/leads"), opcoes);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.organizationId).toBe(ORG);
  });

  it("⭐ cookie de sessão não é afetado, nem lê o plano", async () => {
    limitesDoPlano = PRO;
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u1", idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: "viewer" },
    } as never);

    const r = await resolveAuthDual(new NextRequest("http://localhost/api/v1/leads"), opcoes);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe("session");
    expect(planoDaOrganizacao).not.toHaveBeenCalled();
  });

  it("GET /api/v1/contacts (bearer inline): Pro é 402, Max é 200", async () => {
    const { GET } = await import("@/app/api/v1/contacts/route");
    const pedido = () =>
      new NextRequest("http://localhost/api/v1/contacts", { headers: { authorization: "Bearer dsk_abc_def" } });

    limitesDoPlano = PRO;
    const recusado = await GET(pedido());
    expect(recusado.status).toBe(402);
    expect(((await recusado.json()) as { error: { code: string } }).error.code).toBe("plano_sem_api");

    esquecerTudo();
    limitesDoPlano = MAX;
    const aceito = await GET(pedido());
    expect(aceito.status).toBe(200);
  });
});
