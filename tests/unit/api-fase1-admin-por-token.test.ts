/**
 * API fase 1 (17/10/2026): operações de ADMINISTRAÇÃO da organização por token
 * `Authorization: Bearer dsk_…`.
 *
 * O que se prova, pelo comportamento das rotas (nada de mock do código sob teste —
 * só a borda: banco falso, autenticador de token, sessão):
 *  - token com papel/escopo suficiente passa; abaixo do piso da sessão ou sem
 *    `mcp:write` leva 403;
 *  - a organização vem da LINHA DO TOKEN: id de outra organização responde 404, e
 *    toda consulta/escrita leva o filtro `organization_id` do token (o client do
 *    token é o admin, sem RLS);
 *  - o audit carrega `actor_api_token_id`;
 *  - o caminho de cookie continua pedindo o MESMO papel de antes;
 *  - `public-paths` só libera o caminho exato (UUID, `$`).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { isPublicPath } from "@/lib/auth/public-paths";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import type { Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return { ...real, validateBearerToken: vi.fn() };
});

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const ORG_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_OUTRA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DONO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ALVO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FUNIL = "ffffffff-ffff-4fff-8fff-ffffffffffff";

interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update" | "delete";
  filtros: Record<string, unknown>;
  patch?: unknown;
}

/** Banco falso: registra cada operação com seus `.eq()` e responde pela tabela. */
function bancoFalso(linhas: Record<string, (c: Chamada) => unknown>) {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const c: Chamada = { tabela, op: "select", filtros: {} };
    const resolver = () => {
      chamadas.push({ ...c });
      const dado = linhas[tabela]?.(c);
      return { data: dado ?? null, error: null, count: Array.isArray(dado) ? dado.length : dado ? 1 : 0 };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      insert: (p: unknown) => ((c.op = "insert"), (c.patch = p), chain),
      update: (p: unknown) => ((c.op = "update"), (c.patch = p), chain),
      delete: () => ((c.op = "delete"), chain),
      eq: (col: string, v: unknown) => ((c.filtros[col] = v), chain),
      is: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => resolver(),
      single: async () => resolver(),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(resolver()).then(ok, ko),
    };
    return chain;
  };
  return { from, chamadas, rpc: async () => ({ data: null, error: null }) };
}

function comoToken(role: Role, scopes: string[]) {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_TOKEN,
    role,
    actor: { type: "api_token", id: TOKEN_ID, role },
    apiTokenId: TOKEN_ID,
    scopes: [...scopes, `role:${role}`],
    createdBy: DONO,
  });
}

function req(url: string, method: string, body?: unknown, bearer = true) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: "Bearer dsk_teste_segredo" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("papel e escopo do token (mesmo piso da sessão)", () => {
  it("GET /team: manager + mcp:read lê; agent leva 403; sem mcp:read leva 403", async () => {
    const db = bancoFalso({ user_organizations: () => [] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const { GET } = await import("@/app/api/v1/team/route");

    comoToken("manager", ["mcp:read"]);
    expect((await GET(req("/api/v1/team", "GET"))).status).toBe(200);
    // A organização do consulta é a do TOKEN.
    expect(db.chamadas[0]?.filtros.organization_id).toBe(ORG_TOKEN);

    comoToken("agent", ["mcp:read"]);
    expect((await GET(req("/api/v1/team", "GET"))).status).toBe(403);

    comoToken("manager", ["mcp:write"]);
    expect((await GET(req("/api/v1/team", "GET"))).status).toBe(403);
  });

  it("POST /team/invite: manager NÃO convida (piso é admin); admin sem mcp:write NÃO convida", async () => {
    const { POST } = await import("@/app/api/v1/team/invite/route");
    const corpo = { invitations: [{ email: "novo@x.com", role: "agent" }] };

    comoToken("manager", ["mcp:write"]);
    expect((await POST(req("/api/v1/team/invite", "POST", corpo))).status).toBe(403);

    comoToken("admin", ["mcp:read"]);
    expect((await POST(req("/api/v1/team/invite", "POST", corpo))).status).toBe(403);
  });

  it("token inválido/revogado fecha em 401 antes de qualquer leitura", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token revoked."));
    const { GET } = await import("@/app/api/v1/team/route");
    expect((await GET(req("/api/v1/team", "GET"))).status).toBe(401);
  });

  it("PATCH config do funil: admin é o piso (manager leva 403)", async () => {
    const { PATCH } = await import("@/app/api/v1/pipelines/[id]/config/route");
    comoToken("manager", ["mcp:write"]);
    const res = await PATCH(req(`/api/v1/pipelines/${FUNIL}/config`, "PATCH", { won_reason_required: true }), {
      params: Promise.resolve({ id: FUNIL }),
    });
    expect(res.status).toBe(403);
  });

  it("PATCH /settings/organizacao: admin é o piso (manager leva 403)", async () => {
    const { PATCH } = await import("@/app/api/v1/settings/organizacao/route");
    comoToken("manager", ["mcp:write"]);
    expect((await PATCH(req("/api/v1/settings/organizacao", "PATCH", { display_name: "X" }))).status).toBe(403);
  });
});

describe("a organização é a do token (isolamento)", () => {
  it("PATCH /team/[user]/role: membro de OUTRA organização → 404 e nenhuma escrita", async () => {
    // Só devolve o membro se o filtro for a organização dele (ORG_OUTRA).
    const db = bancoFalso({
      user_organizations: (c) =>
        c.op === "select" && c.filtros.organization_id === ORG_OUTRA
          ? { id: "m1", user_id: ALVO, role: "agent", revoked_at: null }
          : null,
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/team/[user_id]/role/route");
    // `organization_id` no corpo NÃO é lido.
    const res = await PATCH(req(`/api/v1/team/${ALVO}/role`, "PATCH", { role: "manager", organization_id: ORG_OUTRA }), {
      params: Promise.resolve({ user_id: ALVO }),
    });
    expect(res.status).toBe(404);
    expect(db.chamadas.every((c) => c.filtros.organization_id === ORG_TOKEN)).toBe(true);
    expect(db.chamadas.some((c) => c.op === "update")).toBe(false);
  });

  it("PATCH /team/[user]/role: admin do token muda o papel e o audit leva o token", async () => {
    const db = bancoFalso({
      user_organizations: (c) =>
        c.op === "select" && c.filtros.organization_id === ORG_TOKEN
          ? { id: "m1", user_id: ALVO, role: "agent", revoked_at: null }
          : null,
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/team/[user_id]/role/route");
    const res = await PATCH(req(`/api/v1/team/${ALVO}/role`, "PATCH", { role: "manager" }), {
      params: Promise.resolve({ user_id: ALVO }),
    });
    expect(res.status).toBe(200);
    const escrita = db.chamadas.find((c) => c.op === "update");
    expect(escrita?.filtros.organization_id).toBe(ORG_TOKEN);
    expect(escrita?.patch).toMatchObject({ role: "manager" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "team.role_changed",
        organizationId: ORG_TOKEN,
        actorApiTokenId: TOKEN_ID,
        actorUserId: null,
      }),
    );
  });

  it("revogar o acesso do próprio DONO da chave é recusado (a chave morreria junto)", async () => {
    const db = bancoFalso({ user_organizations: () => null });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/team/[user_id]/revoke/route");
    const res = await POST(req(`/api/v1/team/${DONO}/revoke`, "POST"), {
      params: Promise.resolve({ user_id: DONO }),
    });
    expect(res.status).toBe(409);
    expect(db.chamadas).toEqual([]);
  });

  it("PATCH config do funil de outra organização → 404, sem escrita; do próprio → grava e audita o token", async () => {
    const db = bancoFalso({
      crm_pipelines: (c) =>
        c.filtros.organization_id === ORG_TOKEN
          ? { id: FUNIL, name: "Vendas", vocabulary: {}, settings: { fields: [] } }
          : null,
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const { PATCH } = await import("@/app/api/v1/pipelines/[id]/config/route");
    const OUTRO = "99999999-9999-4999-8999-999999999999";

    comoToken("admin", ["mcp:write"]);
    // Funil que não é da org do token: o lookup filtrado por organização não acha.
    const bancoVazio = bancoFalso({ crm_pipelines: () => null });
    vi.mocked(createAdminClient).mockReturnValue(bancoVazio as never);
    const alheio = await PATCH(req(`/api/v1/pipelines/${OUTRO}/config`, "PATCH", { won_reason_required: true }), {
      params: Promise.resolve({ id: OUTRO }),
    });
    expect(alheio.status).toBe(404);
    expect(bancoVazio.chamadas.some((c) => c.op === "update")).toBe(false);

    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const meu = await PATCH(req(`/api/v1/pipelines/${FUNIL}/config`, "PATCH", { won_reason_required: true }), {
      params: Promise.resolve({ id: FUNIL }),
    });
    expect(meu.status).toBe(200);
    const escrita = db.chamadas.find((c) => c.op === "update");
    expect(escrita?.filtros).toMatchObject({ id: FUNIL, organization_id: ORG_TOKEN });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pipeline.config_updated", actorApiTokenId: TOKEN_ID }),
    );
  });

  it("etapa: cor inválida é recusada (422); cor válida chega ao banco com o filtro da organização do token", async () => {
    const etapa = { id: "s1", name: "Novo", slug: "novo", position: 1000, is_won: false, is_lost: false, is_archived: false };
    const db = bancoFalso({
      crm_pipelines: (c) => (c.filtros.organization_id === ORG_TOKEN ? { id: FUNIL } : null),
      crm_stages: (c) => (c.op === "select" ? [etapa] : null),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/pipelines/[id]/stages/[stageId]/route");
    const ctx = { params: Promise.resolve({ id: FUNIL, stageId: "s1" }) };

    const ruim = await PATCH(req(`/api/v1/pipelines/${FUNIL}/stages/s1`, "PATCH", { color: "azul" }), ctx);
    expect(ruim.status).toBe(422);
    expect(db.chamadas.some((c) => c.op === "update")).toBe(false);

    const boa = await PATCH(req(`/api/v1/pipelines/${FUNIL}/stages/s1`, "PATCH", { color: "#3B82F6" }), ctx);
    expect(boa.status).toBe(200);
    const escrita = db.chamadas.find((c) => c.tabela === "crm_stages" && c.op === "update");
    expect(escrita?.patch).toMatchObject({ color: "#3B82F6" });
    expect(escrita?.filtros).toMatchObject({ id: "s1", organization_id: ORG_TOKEN });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pipeline.stage_updated", actorApiTokenId: TOKEN_ID }),
    );
  });

  it("PATCH /settings/organizacao: token admin grava a organização DELE e o audit leva o token", async () => {
    const atual = {
      display_name: "Acme",
      legal_name: "Acme Ltda",
      cnpj: null,
      country: null,
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      currency: "BRL",
      media_retention_days: 365,
      dpo_email: null,
      privacy_policy_url: null,
      onboarding_state: null,
      interface_settings: null,
    };
    const db = bancoFalso({ organizations: (c) => (c.op === "select" ? atual : null) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/settings/organizacao/route");
    const res = await PATCH(req("/api/v1/settings/organizacao", "PATCH", { display_name: "Acme 2" }));
    expect(res.status).toBe(200);
    const escrita = db.chamadas.find((c) => c.op === "update");
    expect(escrita?.filtros.id).toBe(ORG_TOKEN);
    expect(escrita?.patch).toMatchObject({ display_name: "Acme 2", legal_name: "Acme Ltda" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.updated", organizationId: ORG_TOKEN, actorApiTokenId: TOKEN_ID }),
    );
  });
});

describe("o caminho de cookie não mudou", () => {
  it("sem Bearer, a rota pede o MESMO papel de antes via requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: DONO, idioma: "pt-BR" },
      org: { orgId: ORG_TOKEN, name: "Acme", role: "admin" },
    } as never);
    vi.mocked(createClient).mockResolvedValue(bancoFalso({ user_organizations: () => [] }) as never);
    const { GET } = await import("@/app/api/v1/team/route");
    const res = await GET(req("/api/v1/team", "GET", undefined, false));
    expect(res.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
    expect(validateBearerToken).not.toHaveBeenCalled();

    const { PATCH } = await import("@/app/api/v1/settings/organizacao/route");
    await PATCH(req("/api/v1/settings/organizacao", "PATCH", { display_name: "X" }, false));
    expect(vi.mocked(requireRole).mock.calls.at(-1)?.[0]).toBe("admin");
  });
});

describe("public-paths: só o caminho exato passa pelo proxy", () => {
  const U = "11111111-1111-4111-8111-111111111111";
  it("libera as rotas convertidas", () => {
    for (const p of [
      "/api/v1/team",
      "/api/v1/team/invite",
      "/api/v1/team/invites",
      `/api/v1/team/invites/${U}/resend`,
      `/api/v1/team/invites/${U}/revoke`,
      `/api/v1/team/${U}`,
      `/api/v1/team/${U}/role`,
      `/api/v1/team/${U}/revoke`,
      `/api/v1/team/${U}/reactivate`,
      "/api/v1/pipelines",
      `/api/v1/pipelines/${U}`,
      `/api/v1/pipelines/${U}/stages`,
      `/api/v1/pipelines/${U}/stages/${U}`,
      `/api/v1/pipelines/${U}/config`,
      "/api/v1/webhook-sources",
      `/api/v1/webhook-sources/${U}`,
      `/api/v1/webhook-sources/${U}/events`,
      "/api/v1/settings/organizacao",
      "/api/v1/leads",
      `/api/v1/leads/${U}/move`,
      `/api/v1/leads/${U}/win`,
      `/api/v1/leads/${U}/lose`,
      `/api/v1/contacts/${U}`,
      "/api/v1/contacts/merge",
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it("não libera irmãos literais, sub-paths nem prefixos de carona", () => {
    for (const p of [
      "/api/v1/team/assignable",
      `/api/v1/team/${U}/interface`,
      "/api/v1/team/invites/x/resend",
      "/api/v1/pipelines/default",
      `/api/v1/pipelines/${U}/board`,
      `/api/v1/pipelines/${U}/agent-mapping`,
      `/api/v1/pipelines/${U}/stages/${U}/extra`,
      `/api/v1/pipelines/${U}/config/extra`,
      "/api/v1/webhook-sources/x",
      `/api/v1/webhook-sources/${U}/outro`,
      "/api/v1/settings/organizacao/extra",
      "/api/v1/settings/api-tokens",
      "/api/v1/leads/bulk",
      `/api/v1/leads/${U}/clone`,
      `/api/v1/contacts/${U}/consent`,
      "/api/v1/contacts/import",
      "/api/v1/contacts/duplicates",
    ]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});
