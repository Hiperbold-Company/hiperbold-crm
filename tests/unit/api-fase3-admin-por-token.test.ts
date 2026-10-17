/**
 * API fase 3 (17/10/2026): administração da operação por token `Authorization: Bearer dsk_…`.
 *
 * O que se prova, pelo comportamento das rotas (só a borda é falsa: banco, autenticador de token,
 * sessão): sem credencial → 401; papel/escopo abaixo do piso da tela → 403; token de agente de IA →
 * 403; organização SEMPRE a do token (id de outra organização responde 404 e nada é escrito); audit
 * carrega o token; segredo nunca no audit/recibo/resposta; sessão continua funcionando como antes.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import type { Role } from "@/lib/auth/types";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/ai/embeddings/chave", () => ({ temChaveDeEmbedding: vi.fn(async () => true) }));
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

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const ORG_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_OUTRA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DONO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MODELO = "11111111-1111-4111-8111-111111111111";

export interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update" | "delete";
  filtros: Record<string, unknown>;
  patch?: unknown;
}

/**
 * Banco falso: registra cada operação com seus `.eq()`/`.is()`/`.or()`, devolve a linha da tabela e,
 * em `single()/maybeSingle()`, desembrulha lista em primeiro item (como o PostgREST).
 */
/** Uma linha do dublê que devolve `{ __erro }` vira `{ data: null, error }` (ex.: violação de unicidade). */
export function bancoFalso(
  linhas: Record<string, (c: Chamada) => unknown>,
  rpc?: (nome: string, args: Record<string, unknown>) => unknown,
) {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const c: Chamada = { tabela, op: "select", filtros: {} };
    const resolver = (unico: boolean) => {
      chamadas.push({ ...c, filtros: { ...c.filtros } });
      let dado = linhas[tabela]?.(c) ?? null;
      if (unico && Array.isArray(dado)) dado = dado[0] ?? null;
      if (dado && typeof dado === "object" && "__erro" in (dado as object)) {
        return { data: null, error: (dado as { __erro: unknown }).__erro, count: 0 };
      }
      return { data: dado, error: null, count: Array.isArray(dado) ? dado.length : dado ? 1 : 0 };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      insert: (p: unknown) => ((c.op = "insert"), (c.patch = p), chain),
      update: (p: unknown) => ((c.op = "update"), (c.patch = p), chain),
      delete: () => ((c.op = "delete"), chain),
      eq: (col: string, v: unknown) => ((c.filtros[col] = v), chain),
      in: (col: string, v: unknown) => ((c.filtros[`in:${col}`] = v), chain),
      is: (col: string, v: unknown) => ((c.filtros[`is:${col}`] = v), chain),
      or: (expr: string) => ((c.filtros.or = expr), chain),
      neq: (col: string, v: unknown) => ((c.filtros[`neq:${col}`] = v), chain),
      gt: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => resolver(true),
      single: async () => resolver(true),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(resolver(false)).then(ok, ko),
    };
    return chain;
  };
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  return {
    from,
    chamadas,
    rpcs,
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      return { data: rpc ? rpc(nome, args) : null, error: null };
    },
  };
}

export function comoToken(role: Role, scopes: string[], actorType: "api_token" | "ai_agent" = "api_token") {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_TOKEN,
    role,
    actor:
      actorType === "api_token"
        ? { type: "api_token", id: TOKEN_ID, role }
        : { type: "ai_agent", id: TOKEN_ID, role, api_token_id: TOKEN_ID },
    apiTokenId: TOKEN_ID,
    scopes: [...scopes, `role:${role}`],
    createdBy: DONO,
  } as never);
}

export function req(url: string, method: string, body?: unknown, headers: Record<string, string> = {}, bearer = true) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: "Bearer dsk_teste_segredo" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const ctxDe = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks();
  // Sem Bearer, cai na sessão — e a sessão aqui é "ninguém logado".
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: { code: "unauthenticated" } }), { status: 401 }),
  } as never);
});

function comoSessao(role: Role) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: DONO, idioma: "pt-BR" },
    org: { orgId: ORG_TOKEN, role },
  } as never);
}

// ---------------------------------------------------------------------------
// respostas prontas
// ---------------------------------------------------------------------------

describe("respostas prontas (message-templates)", () => {
  const base = "/api/v1/message-templates";
  const linha = {
    id: MODELO,
    organization_id: ORG_TOKEN,
    owner_user_id: null,
    title: "Boas-vindas",
    body: "Olá {{nome}}",
    shortcut: "oi",
    created_by_user_id: DONO,
    created_at: "2026-10-17T00:00:00Z",
    updated_at: "2026-10-17T00:00:00Z",
  };

  it("o proxy deixa passar só os dois caminhos exatos", () => {
    expect(isPublicPath(base)).toBe(true);
    expect(isPublicPath(`${base}/${MODELO}`)).toBe(true);
    expect(isPublicPath(`${base}/nao-e-uuid`)).toBe(false);
    expect(isPublicPath(`${base}/${MODELO}/outra`)).toBe(false);
  });

  it("GET: sem credencial 401; sem mcp:read 403; agente de IA 403", async () => {
    const { GET } = await import("@/app/api/v1/message-templates/route");
    expect((await GET(req(base, "GET", undefined, {}, false))).status).toBe(401);
    comoToken("agent", ["mcp:write"]);
    expect((await GET(req(base, "GET"))).status).toBe(403);
    comoToken("admin", ["mcp:read"], "ai_agent");
    expect((await GET(req(base, "GET"))).status).toBe(403);
  });

  it("GET por token: só as COMPARTILHADAS da organização do token (nunca a pessoal de um atendente)", async () => {
    const db = bancoFalso({ message_templates: () => [linha] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("agent", ["mcp:read"]);
    const { GET } = await import("@/app/api/v1/message-templates/route");
    const res = await GET(req(`${base}?organization_id=${ORG_OUTRA}`, "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([linha]);
    expect(db.chamadas[0]!.filtros).toMatchObject({ organization_id: ORG_TOKEN, "is:owner_user_id": null });
    expect(db.chamadas[0]!.filtros.or).toBeUndefined();
  });

  it("GET pela SESSÃO: compartilhadas + as do próprio usuário (a régua da RLS, repetida)", async () => {
    const db = bancoFalso({ message_templates: () => [linha] });
    vi.mocked(createClient).mockResolvedValue(db as never);
    comoSessao("agent");
    const { GET } = await import("@/app/api/v1/message-templates/route");
    const res = await GET(req(base, "GET", undefined, {}, false));
    expect(res.status).toBe(200);
    expect(db.chamadas[0]!.filtros.or).toBe(`owner_user_id.is.null,owner_user_id.eq.${DONO}`);
    expect(db.chamadas[0]!.filtros.organization_id).toBe(ORG_TOKEN);
  });

  it("POST: agent → 403 (a chave só escreve compartilhada, papel de gerente); sem mcp:write 403; agente de IA 403; sem credencial 401", async () => {
    const { POST } = await import("@/app/api/v1/message-templates/route");
    const corpo = { title: "T", body: "B", shared: true };
    expect((await POST(req(base, "POST", corpo, {}, false))).status).toBe(401);
    comoToken("agent", ["mcp:write"]);
    expect((await POST(req(base, "POST", corpo))).status).toBe(403);
    comoToken("manager", ["mcp:read"]);
    expect((await POST(req(base, "POST", corpo))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await POST(req(base, "POST", corpo))).status).toBe(403);
  });

  it("POST por token: cria compartilhada na organização do TOKEN, com a pessoa dona da chave e audit com o token", async () => {
    const db = bancoFalso({ message_templates: () => linha });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/message-templates/route");
    const res = await POST(
      req(base, "POST", { title: "Boas-vindas", body: "Olá", shortcut: "oi", shared: true, organization_id: ORG_OUTRA }),
    );
    expect(res.status).toBe(201);
    const insert = db.chamadas.find((c) => c.op === "insert");
    expect(insert?.patch).toMatchObject({
      organization_id: ORG_TOKEN,
      owner_user_id: null,
      created_by_user_id: DONO,
    });
    expect(JSON.stringify(insert?.patch)).not.toContain(ORG_OUTRA);
    const a = vi.mocked(audit).mock.calls.find((c) => c[0].action === "template.created")?.[0];
    expect(a).toMatchObject({ organizationId: ORG_TOKEN, actorApiTokenId: TOKEN_ID, actorUserId: null });
  });

  it("POST por token com shared=false (padrão) → 422: chave não tem resposta pessoal; nada é escrito", async () => {
    const db = bancoFalso({ message_templates: () => linha });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/message-templates/route");
    const res = await POST(req(base, "POST", { title: "T", body: "B" }));
    expect(res.status).toBe(422);
    expect(db.chamadas.some((c) => c.op === "insert")).toBe(false);
  });

  it("POST: corpo inválido → 422; Idempotency-Key que não é UUID → 400; ambos sem escrita", async () => {
    const db = bancoFalso({ message_templates: () => linha });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/message-templates/route");
    expect((await POST(req(base, "POST", { title: "", body: "B", shared: true }))).status).toBe(422);
    const ruim = await POST(req(base, "POST", { title: "T", body: "B", shared: true }, { "Idempotency-Key": "x" }));
    expect(ruim.status).toBe(400);
    expect(db.chamadas.some((c) => c.op === "insert")).toBe(false);
  });

  it("POST pela SESSÃO: agent cria pessoal (owner = ele); agent não cria compartilhada (403)", async () => {
    const db = bancoFalso({ message_templates: () => ({ ...linha, owner_user_id: DONO }) });
    vi.mocked(createClient).mockResolvedValue(db as never);
    comoSessao("agent");
    const { POST } = await import("@/app/api/v1/message-templates/route");
    const pessoal = await POST(req(base, "POST", { title: "T", body: "B" }, {}, false));
    expect(pessoal.status).toBe(201);
    expect(db.chamadas.find((c) => c.op === "insert")?.patch).toMatchObject({
      owner_user_id: DONO,
      created_by_user_id: DONO,
      organization_id: ORG_TOKEN,
    });
    const compartilhada = await POST(req(base, "POST", { title: "T", body: "B", shared: true }, {}, false));
    expect(compartilhada.status).toBe(403);
  });

  it("PATCH/DELETE: papel e escopo; id fora de UUID → 400", async () => {
    const { PATCH, DELETE } = await import("@/app/api/v1/message-templates/[id]/route");
    const url = `${base}/${MODELO}`;
    expect((await PATCH(req(url, "PATCH", { title: "N" }, {}, false), ctxDe({ id: MODELO }))).status).toBe(401);
    comoToken("agent", ["mcp:write"]);
    expect((await PATCH(req(url, "PATCH", { title: "N" }), ctxDe({ id: MODELO }))).status).toBe(403);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: MODELO }))).status).toBe(403);
    comoToken("manager", ["mcp:read"]);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: MODELO }))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: MODELO }))).status).toBe(403);
    comoToken("manager", ["mcp:write"]);
    expect((await DELETE(req(`${base}/xx`, "DELETE"), ctxDe({ id: "xx" }))).status).toBe(400);
  });

  it("PATCH por token: filtra por organização do token E só as compartilhadas; outra organização → 404", async () => {
    const db = bancoFalso({
      message_templates: (c) => (c.filtros.organization_id === ORG_TOKEN ? [{ ...linha, title: "N" }] : null),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/message-templates/[id]/route");
    const res = await PATCH(req(`${base}/${MODELO}`, "PATCH", { title: "N" }), ctxDe({ id: MODELO }));
    expect(res.status).toBe(200);
    expect(db.chamadas[0]!.filtros).toMatchObject({ id: MODELO, organization_id: ORG_TOKEN, "is:owner_user_id": null });
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "template.updated")?.[0]).toMatchObject({
      actorApiTokenId: TOKEN_ID,
      actorUserId: null,
    });

    const vazio = bancoFalso({ message_templates: () => null });
    vi.mocked(createAdminClient).mockReturnValue(vazio as never);
    const nao = await PATCH(req(`${base}/${MODELO}`, "PATCH", { title: "N" }), ctxDe({ id: MODELO }));
    expect(nao.status).toBe(404);
  });

  it("PATCH sem campo nenhum → 422", async () => {
    comoToken("manager", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/message-templates/[id]/route");
    expect((await PATCH(req(`${base}/${MODELO}`, "PATCH", {}), ctxDe({ id: MODELO }))).status).toBe(422);
  });

  it("DELETE por token: 204 quando apagou (compartilhada da organização do token), 404 quando não achou", async () => {
    const db = bancoFalso({ message_templates: () => [{ id: MODELO }] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { DELETE } = await import("@/app/api/v1/message-templates/[id]/route");
    const res = await DELETE(req(`${base}/${MODELO}`, "DELETE"), ctxDe({ id: MODELO }));
    expect(res.status).toBe(204);
    expect(db.chamadas[0]).toMatchObject({ op: "delete" });
    expect(db.chamadas[0]!.filtros).toMatchObject({ id: MODELO, organization_id: ORG_TOKEN, "is:owner_user_id": null });
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "template.deleted")?.[0]).toMatchObject({
      actorApiTokenId: TOKEN_ID,
    });

    vi.mocked(createAdminClient).mockReturnValue(bancoFalso({ message_templates: () => null }) as never);
    expect((await DELETE(req(`${base}/${MODELO}`, "DELETE"), ctxDe({ id: MODELO }))).status).toBe(404);
  });

  it("token revogado/inválido → 401 antes de qualquer leitura", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token revoked."));
    const { GET } = await import("@/app/api/v1/message-templates/route");
    expect((await GET(req(base, "GET"))).status).toBe(401);
  });
});


// ---------------------------------------------------------------------------
// fluxos de follow-up
// ---------------------------------------------------------------------------

describe("fluxos de follow-up (ai/followup-flows)", () => {
  const FLUXO = "22222222-2222-4222-8222-222222222222";
  const VERSAO = "33333333-3333-4333-8333-333333333333";
  const base = "/api/v1/ai/followup-flows";
  const ponteiro = {
    id: FLUXO,
    name: "Retorno",
    status: "draft",
    active_version_id: null,
    draft_graph: null,
    handoff_policy: "pause",
    trigger_config: { kind: "manual" },
    surface: "followup",
    created_at: "2026-10-17T00:00:00Z",
    updated_at: "2026-10-17T00:00:00Z",
  };
  const pos = { x: 0, y: 0 };
  const grafoValido = {
    nodes: [
      { id: "t1", type: "trigger", label: "t1", position: pos, config: {} },
      { id: "e1", type: "end", label: "e1", position: pos, config: { outcome: "exhausted" } },
    ],
    edges: [{ id: "edge1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
  };
  const daOrg = (c: Chamada) => c.filtros.organization_id === ORG_TOKEN;

  it("o proxy deixa passar só os caminhos exatos", () => {
    expect(isPublicPath(base)).toBe(true);
    expect(isPublicPath(`${base}/${FLUXO}`)).toBe(true);
    for (const acao of ["publish", "disable", "duplicate", "rollback"]) {
      expect(isPublicPath(`${base}/${FLUXO}/${acao}`)).toBe(true);
    }
    expect(isPublicPath(`${base}/${FLUXO}/enroll`)).toBe(false);
    expect(isPublicPath(`${base}/nao-e-uuid`)).toBe(false);
    expect(isPublicPath(`${base}/from-model`)).toBe(false);
  });

  it("GET: sem credencial 401; sem mcp:read 403; agente de IA 403; viewer+mcp:read lê só a organização do token", async () => {
    const { GET } = await import("@/app/api/v1/ai/followup-flows/route");
    expect((await GET(req(base, "GET", undefined, {}, false))).status).toBe(401);
    comoToken("admin", ["mcp:write"]);
    expect((await GET(req(base, "GET"))).status).toBe(403);
    comoToken("admin", ["mcp:read"], "ai_agent");
    expect((await GET(req(base, "GET"))).status).toBe(403);

    const db = bancoFalso({ followup_flow_pointers: () => [ponteiro] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("viewer", ["mcp:read"]);
    const res = await GET(req(`${base}?organization_id=${ORG_OUTRA}`, "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([ponteiro]);
    expect(db.chamadas[0]!.filtros).toMatchObject({ organization_id: ORG_TOKEN, "neq:surface": "atendimento" });
  });

  it("POST: viewer/agent → 403; sem mcp:write 403; agente de IA 403; 401 sem credencial", async () => {
    const { POST } = await import("@/app/api/v1/ai/followup-flows/route");
    expect((await POST(req(base, "POST", { name: "X" }, {}, false))).status).toBe(401);
    comoToken("agent", ["mcp:write"]);
    expect((await POST(req(base, "POST", { name: "X" }))).status).toBe(403);
    comoToken("manager", ["mcp:read"]);
    expect((await POST(req(base, "POST", { name: "X" }))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await POST(req(base, "POST", { name: "X" }))).status).toBe(403);
  });

  it("POST por token: cria na organização do TOKEN (body com organization_id é recusado), audit com o token", async () => {
    const db = bancoFalso({ followup_flow_pointers: () => ponteiro });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/route");
    const intruso = await POST(req(base, "POST", { name: "Retorno", organization_id: ORG_OUTRA }));
    expect(intruso.status).toBe(422);
    expect(db.chamadas.some((c) => c.op === "insert")).toBe(false);

    const res = await POST(req(base, "POST", { name: "Retorno" }));
    expect(res.status).toBe(201);
    expect(db.chamadas.find((c) => c.op === "insert")?.patch).toMatchObject({ organization_id: ORG_TOKEN, name: "Retorno" });
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "followup_flow.created")?.[0]).toMatchObject({
      organizationId: ORG_TOKEN,
      actorApiTokenId: TOKEN_ID,
      actorUserId: null,
    });
  });

  it("POST: nome repetido → 409; nome vazio → 422", async () => {
    const db = bancoFalso({ followup_flow_pointers: () => ({ __erro: { code: "23505", message: "dup" } }) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/route");
    expect((await POST(req(base, "POST", { name: "Retorno" }))).status).toBe(409);
    expect((await POST(req(base, "POST", { name: "" }))).status).toBe(422);
  });

  it("GET /[id]: id fora de UUID → 400; outra organização → 404; da organização → 200", async () => {
    const { GET } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    comoToken("viewer", ["mcp:read"]);
    expect((await GET(req(`${base}/xx`, "GET"), ctxDe({ id: "xx" }))).status).toBe(400);

    vi.mocked(createAdminClient).mockReturnValue(
      bancoFalso({ followup_flow_pointers: (c) => (daOrg(c) ? null : [ponteiro]) }) as never,
    );
    expect((await GET(req(`${base}/${FLUXO}`, "GET"), ctxDe({ id: FLUXO }))).status).toBe(404);

    const db = bancoFalso({
      followup_flow_pointers: (c) => (daOrg(c) ? [{ ...ponteiro, draft_graph: grafoValido }] : null),
      followup_flow_versions: () => [{ id: VERSAO, created_at: "2026-10-17" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const res = await GET(req(`${base}/${FLUXO}`, "GET"), ctxDe({ id: FLUXO }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: FLUXO, versions_count: 1 });
  });

  it("PATCH: piso manager; token só altera na organização dele; campo desconhecido → 422; outra org → 404", async () => {
    const { PATCH } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    const url = `${base}/${FLUXO}`;
    comoToken("agent", ["mcp:write"]);
    expect((await PATCH(req(url, "PATCH", { name: "N" }), ctxDe({ id: FLUXO }))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await PATCH(req(url, "PATCH", { name: "N" }), ctxDe({ id: FLUXO }))).status).toBe(403);

    comoToken("manager", ["mcp:write"]);
    const db = bancoFalso({ followup_flow_pointers: (c) => (daOrg(c) ? [ponteiro] : null) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const res = await PATCH(req(url, "PATCH", { name: "N", handoff_policy: "cancel" }), ctxDe({ id: FLUXO }));
    expect(res.status).toBe(200);
    const escrita = db.chamadas.find((c) => c.op === "update");
    expect(escrita?.filtros).toMatchObject({ id: FLUXO, organization_id: ORG_TOKEN });
    expect(escrita?.patch).toMatchObject({ name: "N", handoff_policy: "cancel" });

    expect((await PATCH(req(url, "PATCH", { organization_id: ORG_OUTRA }), ctxDe({ id: FLUXO }))).status).toBe(422);

    vi.mocked(createAdminClient).mockReturnValue(bancoFalso({ followup_flow_pointers: () => null }) as never);
    expect((await PATCH(req(url, "PATCH", { name: "N" }), ctxDe({ id: FLUXO }))).status).toBe(404);
  });

  it("DELETE: tudo filtrado pela organização do token; outra organização → 404 e nada é apagado", async () => {
    const { DELETE } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    const url = `${base}/${FLUXO}`;
    comoToken("manager", ["mcp:read"]);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: FLUXO }))).status).toBe(403);

    comoToken("manager", ["mcp:write"]);
    const outra = bancoFalso({ followup_flow_pointers: () => null });
    vi.mocked(createAdminClient).mockReturnValue(outra as never);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: FLUXO }))).status).toBe(404);
    expect(outra.chamadas.some((c) => c.op === "delete")).toBe(false);

    const db = bancoFalso({ followup_flow_pointers: () => [ponteiro] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: FLUXO }))).status).toBe(200);
    const apagou = db.chamadas.filter((c) => c.op === "delete");
    expect(apagou.map((c) => c.tabela)).toEqual(["followup_enrollments", "followup_flow_versions", "followup_flow_pointers"]);
    expect(apagou.every((c) => c.filtros.organization_id === ORG_TOKEN)).toBe(true);
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "followup_flow.deleted")?.[0]).toMatchObject({
      actorApiTokenId: TOKEN_ID,
    });
  });

  it("publish: papel/escopo; sem rascunho → 422; reprovado → 422 com erros; ok → versão ligada à PESSOA dona da chave", async () => {
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/publish/route");
    const url = `${base}/${FLUXO}/publish`;
    expect((await POST(req(url, "POST", undefined, {}, false), ctxDe({ id: FLUXO }))).status).toBe(401);
    comoToken("agent", ["mcp:write"]);
    expect((await POST(req(url, "POST"), ctxDe({ id: FLUXO }))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await POST(req(url, "POST"), ctxDe({ id: FLUXO }))).status).toBe(403);

    comoToken("manager", ["mcp:write"]);
    const semRascunho = bancoFalso({ followup_flow_pointers: () => [ponteiro] });
    vi.mocked(createAdminClient).mockReturnValue(semRascunho as never);
    const sem = await POST(req(url, "POST"), ctxDe({ id: FLUXO }));
    expect(sem.status).toBe(422);
    expect(semRascunho.rpcs).toEqual([]);

    const reprovado = bancoFalso({
      followup_flow_pointers: () => [
        {
          ...ponteiro,
          draft_graph: {
            nodes: [...grafoValido.nodes, { id: "orf", type: "end", label: "orf", position: pos, config: { outcome: "exhausted" } }],
            edges: grafoValido.edges,
          },
        },
      ],
      channel_sessions: () => [],
    });
    vi.mocked(createAdminClient).mockReturnValue(reprovado as never);
    const rep = await POST(req(url, "POST"), ctxDe({ id: FLUXO }));
    expect(rep.status).toBe(422);
    expect((await rep.json()).error.details.errors.length).toBeGreaterThan(0);
    expect(reprovado.rpcs).toEqual([]);

    const bom = bancoFalso(
      {
        followup_flow_pointers: (c) =>
          daOrg(c)
            ? [{ ...ponteiro, status: "active", active_version_id: VERSAO, draft_graph: grafoValido }]
            : null,
        channel_sessions: () => [],
      },
      (nome) => (nome === "fn_publish_followup_flow_version" ? VERSAO : null),
    );
    vi.mocked(createAdminClient).mockReturnValue(bom as never);
    const res = await POST(req(url, "POST"), ctxDe({ id: FLUXO }));
    expect(res.status).toBe(200);
    expect(bom.rpcs[0]).toMatchObject({
      nome: "fn_publish_followup_flow_version",
      args: { p_org: ORG_TOKEN, p_pointer: FLUXO, p_created_by: DONO },
    });
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "followup_flow.published")?.[0]).toMatchObject({
      organizationId: ORG_TOKEN,
      actorApiTokenId: TOKEN_ID,
    });
  });

  it("publish de fluxo de OUTRA organização → 404, nada publicado", async () => {
    const db = bancoFalso({ followup_flow_pointers: (c) => (daOrg(c) ? null : [ponteiro]) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/publish/route");
    expect((await POST(req(`${base}/${FLUXO}/publish`, "POST"), ctxDe({ id: FLUXO }))).status).toBe(404);
    expect(db.rpcs).toEqual([]);
  });

  it("disable / duplicate / rollback: piso manager, organização do token, 404 fora dela", async () => {
    comoToken("agent", ["mcp:write"]);
    const { POST: desativar } = await import("@/app/api/v1/ai/followup-flows/[id]/disable/route");
    const { POST: duplicar } = await import("@/app/api/v1/ai/followup-flows/[id]/duplicate/route");
    const { POST: reverter } = await import("@/app/api/v1/ai/followup-flows/[id]/rollback/route");
    expect((await desativar(req(`${base}/${FLUXO}/disable`, "POST"), ctxDe({ id: FLUXO }))).status).toBe(403);
    expect((await duplicar(req(`${base}/${FLUXO}/duplicate`, "POST"), ctxDe({ id: FLUXO }))).status).toBe(403);
    expect(
      (await reverter(req(`${base}/${FLUXO}/rollback`, "POST", { version_id: VERSAO }), ctxDe({ id: FLUXO }))).status,
    ).toBe(403);

    comoToken("manager", ["mcp:write"]);
    const db = bancoFalso({
      followup_flow_pointers: (c) => (c.op === "insert" || daOrg(c) ? [{ ...ponteiro, status: "active" }] : null),
      followup_flow_versions: (c) => (daOrg(c) && c.filtros.pointer_id === FLUXO ? [{ id: VERSAO }] : null),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    expect((await desativar(req(`${base}/${FLUXO}/disable`, "POST"), ctxDe({ id: FLUXO }))).status).toBe(200);
    expect(db.chamadas.find((c) => c.op === "update")?.filtros).toMatchObject({ id: FLUXO, organization_id: ORG_TOKEN });
    const dup = await duplicar(req(`${base}/${FLUXO}/duplicate`, "POST"), ctxDe({ id: FLUXO }));
    expect(dup.status).toBe(201);
    expect(db.chamadas.find((c) => c.op === "insert")?.patch).toMatchObject({ organization_id: ORG_TOKEN, status: "draft" });
    expect(
      (await reverter(req(`${base}/${FLUXO}/rollback`, "POST", { version_id: VERSAO }), ctxDe({ id: FLUXO }))).status,
    ).toBe(200);
    // version_id obrigatório e em forma de UUID
    expect((await reverter(req(`${base}/${FLUXO}/rollback`, "POST", {}), ctxDe({ id: FLUXO }))).status).toBe(422);

    const fora = bancoFalso({ followup_flow_pointers: () => null });
    vi.mocked(createAdminClient).mockReturnValue(fora as never);
    expect((await desativar(req(`${base}/${FLUXO}/disable`, "POST"), ctxDe({ id: FLUXO }))).status).toBe(404);
    expect((await duplicar(req(`${base}/${FLUXO}/duplicate`, "POST"), ctxDe({ id: FLUXO }))).status).toBe(404);
    expect(
      (await reverter(req(`${base}/${FLUXO}/rollback`, "POST", { version_id: VERSAO }), ctxDe({ id: FLUXO }))).status,
    ).toBe(404);
    expect(fora.chamadas.some((c) => c.op === "update" || c.op === "insert")).toBe(false);
  });

  it("sessão continua funcionando: manager cria pelo cookie (organização da sessão)", async () => {
    const db = bancoFalso({ followup_flow_pointers: () => ponteiro });
    vi.mocked(createClient).mockResolvedValue(db as never);
    vi.mocked(createAdminClient).mockReturnValue(bancoFalso({}) as never);
    comoSessao("manager");
    const { POST } = await import("@/app/api/v1/ai/followup-flows/route");
    const res = await POST(req(base, "POST", { name: "Retorno" }, {}, false));
    expect(res.status).toBe(201);
    expect(db.chamadas.find((c) => c.op === "insert")?.patch).toMatchObject({ organization_id: ORG_TOKEN });
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "followup_flow.created")?.[0]).toMatchObject({
      actorUserId: DONO,
    });
  });
});


// ---------------------------------------------------------------------------
// roteadores de intenção
// ---------------------------------------------------------------------------

describe("roteadores de intenção (ai/routers)", () => {
  const ROTEADOR = "44444444-4444-4444-8444-444444444444";
  const SESSAO = "55555555-5555-4555-8555-555555555555";
  const AGENTE = "66666666-6666-4666-8666-666666666666";
  const base = "/api/v1/ai/routers";
  const roteador = {
    id: ROTEADOR,
    name: "Entrada",
    channel_session_id: SESSAO,
    is_active: true,
    fallback_agent_id: null,
    config: {},
  };
  const daOrg = (c: Chamada) => c.filtros.organization_id === ORG_TOKEN;

  it("o proxy deixa passar só os caminhos exatos", () => {
    expect(isPublicPath(base)).toBe(true);
    expect(isPublicPath(`${base}/${ROTEADOR}`)).toBe(true);
    expect(isPublicPath(`${base}/${ROTEADOR}/members`)).toBe(true);
    expect(isPublicPath(`${base}/${ROTEADOR}/test`)).toBe(false);
    expect(isPublicPath(`${base}/nao-e-uuid`)).toBe(false);
  });

  it("GET: sem credencial 401; sem mcp:read 403; agente de IA 403; leitura só da organização do token", async () => {
    const { GET } = await import("@/app/api/v1/ai/routers/route");
    expect((await GET(req(base, "GET", undefined, {}, false))).status).toBe(401);
    comoToken("admin", ["mcp:write"]);
    expect((await GET(req(base, "GET"))).status).toBe(403);
    comoToken("admin", ["mcp:read"], "ai_agent");
    expect((await GET(req(base, "GET"))).status).toBe(403);

    const db = bancoFalso({
      ai_routers: (c) => (daOrg(c) ? [roteador] : null),
      ai_router_members: () => [{ router_id: ROTEADOR }, { router_id: ROTEADOR }],
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("agent", ["mcp:read"]);
    const res = await GET(req(`${base}?organization_id=${ORG_OUTRA}`, "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.routers[0]).toMatchObject({ id: ROTEADOR, member_count: 2 });
    expect(db.chamadas.every((c) => c.filtros.organization_id === ORG_TOKEN)).toBe(true);
  });

  it("POST: piso admin (manager → 403); sem mcp:write 403; agente de IA 403; 401 sem credencial", async () => {
    const { POST } = await import("@/app/api/v1/ai/routers/route");
    const corpo = { name: "Entrada", channel_session_id: SESSAO };
    expect((await POST(req(base, "POST", corpo, {}, false))).status).toBe(401);
    comoToken("manager", ["mcp:write"]);
    expect((await POST(req(base, "POST", corpo))).status).toBe(403);
    comoToken("admin", ["mcp:read"]);
    expect((await POST(req(base, "POST", corpo))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await POST(req(base, "POST", corpo))).status).toBe(403);
  });

  it("POST por token: cria na organização do TOKEN com a pessoa dona da chave; número de outra organização → 404; 23505 → 409", async () => {
    const { POST } = await import("@/app/api/v1/ai/routers/route");
    const corpo = { name: "Entrada", channel_session_id: SESSAO, organization_id: ORG_OUTRA };
    comoToken("admin", ["mcp:write"]);

    const db = bancoFalso({
      channel_sessions: (c) => (daOrg(c) ? [{ id: SESSAO }] : null),
      ai_routers: () => ({ id: ROTEADOR }),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const res = await POST(req(base, "POST", corpo));
    expect(res.status).toBe(201);
    const insert = db.chamadas.find((c) => c.tabela === "ai_routers" && c.op === "insert");
    expect(insert?.patch).toMatchObject({ organization_id: ORG_TOKEN, created_by: DONO });
    expect(JSON.stringify(insert?.patch)).not.toContain(ORG_OUTRA);
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "ai.router_created")?.[0]).toMatchObject({
      organizationId: ORG_TOKEN,
      actorApiTokenId: TOKEN_ID,
      actorUserId: null,
    });

    const semNumero = bancoFalso({ channel_sessions: () => null, ai_routers: () => ({ id: ROTEADOR }) });
    vi.mocked(createAdminClient).mockReturnValue(semNumero as never);
    expect((await POST(req(base, "POST", corpo))).status).toBe(404);
    expect(semNumero.chamadas.some((c) => c.op === "insert")).toBe(false);

    const duplicado = bancoFalso({
      channel_sessions: () => [{ id: SESSAO }],
      ai_routers: () => ({ __erro: { code: "23505", message: "dup" } }),
    });
    vi.mocked(createAdminClient).mockReturnValue(duplicado as never);
    expect((await POST(req(base, "POST", corpo))).status).toBe(409);
  });

  it("POST com agente de reserva de OUTRA organização → 422, nada gravado", async () => {
    const db = bancoFalso({
      channel_sessions: () => [{ id: SESSAO }],
      ai_agents: (c) => (daOrg(c) ? null : [{ id: AGENTE }]),
      ai_routers: () => ({ id: ROTEADOR }),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/ai/routers/route");
    const res = await POST(req(base, "POST", { name: "E", channel_session_id: SESSAO, fallback_agent_id: AGENTE }));
    expect(res.status).toBe(422);
    expect(db.chamadas.some((c) => c.op === "insert")).toBe(false);
    expect((await POST(req(base, "POST", { name: "", channel_session_id: SESSAO }))).status).toBe(422);
  });

  it("GET/PATCH/DELETE /[id]: id inválido 400; outra organização 404; escrita filtra pela organização do token", async () => {
    const { GET, PATCH, DELETE } = await import("@/app/api/v1/ai/routers/[id]/route");
    const url = `${base}/${ROTEADOR}`;
    comoToken("agent", ["mcp:read", "mcp:write"]);
    expect((await GET(req(`${base}/xx`, "GET"), ctxDe({ id: "xx" }))).status).toBe(400);
    expect((await PATCH(req(url, "PATCH", { name: "N" }), ctxDe({ id: ROTEADOR }))).status).toBe(403);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: ROTEADOR }))).status).toBe(403);

    const fora = bancoFalso({ ai_routers: () => null });
    vi.mocked(createAdminClient).mockReturnValue(fora as never);
    expect((await GET(req(url, "GET"), ctxDe({ id: ROTEADOR }))).status).toBe(404);
    comoToken("admin", ["mcp:write"]);
    expect((await PATCH(req(url, "PATCH", { name: "N" }), ctxDe({ id: ROTEADOR }))).status).toBe(404);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: ROTEADOR }))).status).toBe(404);
    expect(fora.chamadas.some((c) => c.op === "update" || c.op === "delete")).toBe(false);

    const db = bancoFalso({ ai_routers: (c) => (daOrg(c) ? [roteador] : null) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    expect((await PATCH(req(url, "PATCH", { is_active: false }), ctxDe({ id: ROTEADOR }))).status).toBe(200);
    expect(db.chamadas.find((c) => c.op === "update")?.filtros).toMatchObject({ id: ROTEADOR, organization_id: ORG_TOKEN });
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: ROTEADOR }))).status).toBe(200);
    expect(db.chamadas.find((c) => c.op === "delete")?.filtros).toMatchObject({ id: ROTEADOR, organization_id: ORG_TOKEN });
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "ai.router_deleted")?.[0]).toMatchObject({
      actorApiTokenId: TOKEN_ID,
    });
  });

  it("PUT /members: piso admin; agente de IA 403; grava na organização do token; agente de outra organização → 422", async () => {
    vi.stubEnv("SUPABASE_DB_URL", "");
    const { PUT } = await import("@/app/api/v1/ai/routers/[id]/members/route");
    const url = `${base}/${ROTEADOR}/members`;
    const membros = {
      members: [{ agent_id: AGENTE, intent_name: "Vendas", intent_description: "Quer comprar" }],
    };
    comoToken("manager", ["mcp:write"]);
    expect((await PUT(req(url, "PUT", membros), ctxDe({ id: ROTEADOR }))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await PUT(req(url, "PUT", membros), ctxDe({ id: ROTEADOR }))).status).toBe(403);

    comoToken("admin", ["mcp:write"]);
    const db = bancoFalso({
      ai_routers: (c) => (daOrg(c) ? [roteador] : null),
      ai_agents: (c) => (daOrg(c) ? [{ id: AGENTE }] : null),
      ai_router_members: () => [],
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const res = await PUT(req(url, "PUT", membros), ctxDe({ id: ROTEADOR }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ count: 1 });
    const insert = db.chamadas.find((c) => c.tabela === "ai_router_members" && c.op === "insert");
    expect(JSON.stringify(insert?.patch)).toContain(ORG_TOKEN);
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "ai.router_members_updated")?.[0]).toMatchObject({
      organizationId: ORG_TOKEN,
      actorApiTokenId: TOKEN_ID,
    });

    const agenteAlheio = bancoFalso({
      ai_routers: () => [roteador],
      ai_agents: () => [],
      ai_router_members: () => [],
    });
    vi.mocked(createAdminClient).mockReturnValue(agenteAlheio as never);
    expect((await PUT(req(url, "PUT", membros), ctxDe({ id: ROTEADOR }))).status).toBe(422);
    expect(agenteAlheio.chamadas.some((c) => c.op === "delete" || c.op === "insert")).toBe(false);

    const semRoteador = bancoFalso({ ai_routers: () => null });
    vi.mocked(createAdminClient).mockReturnValue(semRoteador as never);
    expect((await PUT(req(url, "PUT", membros), ctxDe({ id: ROTEADOR }))).status).toBe(404);
    vi.unstubAllEnvs();
  });
});


// ---------------------------------------------------------------------------
// regras automáticas
// ---------------------------------------------------------------------------

describe("regras automáticas (automation-rules)", () => {
  const REGRA = "77777777-7777-4777-8777-777777777777";
  const base = "/api/v1/automation-rules";
  const SEGREDO = "segredo-do-webhook-em-texto-claro-9";
  const regra = {
    id: REGRA,
    organization_id: ORG_TOKEN,
    name: "Avisar",
    is_active: false,
    trigger_event: "lead.created",
    conditions: [],
    actions: [{ type: "call_webhook", config: { url: "https://exemplo.com/h", secret_enc: "abcdef" } }],
  };
  const corpo = {
    name: "Avisar",
    trigger_event: "lead.created",
    actions: [{ type: "call_webhook", config: { url: "https://exemplo.com/h", secret: SEGREDO } }],
  };
  const daOrg = (c: Chamada) => c.filtros.organization_id === ORG_TOKEN;
  const cifra = (nome: string) => (nome === "fn_encrypt_oauth" ? "\\xcifrado" : null);

  it("o proxy deixa passar só os caminhos exatos", () => {
    expect(isPublicPath(base)).toBe(true);
    expect(isPublicPath(`${base}/${REGRA}`)).toBe(true);
    expect(isPublicPath(`${base}/runs`)).toBe(false);
    expect(isPublicPath(`${base}/${REGRA}/runs`)).toBe(false);
  });

  it("GET: sem credencial 401; agent → 403; sem mcp:read 403; agente de IA 403; chave não recebe segredo cifrado", async () => {
    const { GET } = await import("@/app/api/v1/automation-rules/route");
    expect((await GET(req(base, "GET", undefined, {}, false))).status).toBe(401);
    comoToken("agent", ["mcp:read"]);
    expect((await GET(req(base, "GET"))).status).toBe(403);
    comoToken("manager", ["mcp:write"]);
    expect((await GET(req(base, "GET"))).status).toBe(403);
    comoToken("admin", ["mcp:read"], "ai_agent");
    expect((await GET(req(base, "GET"))).status).toBe(403);

    const db = bancoFalso({ automation_rules: (c) => (daOrg(c) ? [regra] : null) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:read"]);
    const res = await GET(req(`${base}?organization_id=${ORG_OUTRA}`, "GET"));
    expect(res.status).toBe(200);
    const texto = JSON.stringify((await res.json()).data);
    expect(texto).not.toContain("secret_enc");
    expect(texto).toContain('"has_secret":true');
    expect(db.chamadas[0]!.filtros.organization_id).toBe(ORG_TOKEN);
  });

  it("GET pela SESSÃO continua devolvendo o segredo cifrado ao editor (round-trip da tela)", async () => {
    const db = bancoFalso({ automation_rules: () => [regra] });
    vi.mocked(createClient).mockResolvedValue(db as never);
    comoSessao("manager");
    const { GET } = await import("@/app/api/v1/automation-rules/route");
    const res = await GET(req(base, "GET", undefined, {}, false));
    expect(JSON.stringify((await res.json()).data)).toContain("secret_enc");
  });

  it("POST: piso manager (agent → 403); sem mcp:write 403; agente de IA 403; 401 sem credencial", async () => {
    const { POST } = await import("@/app/api/v1/automation-rules/route");
    expect((await POST(req(base, "POST", corpo, {}, false))).status).toBe(401);
    comoToken("agent", ["mcp:write"]);
    expect((await POST(req(base, "POST", corpo))).status).toBe(403);
    comoToken("manager", ["mcp:read"]);
    expect((await POST(req(base, "POST", corpo))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await POST(req(base, "POST", corpo))).status).toBe(403);
  });

  it("POST por token: cria PAUSADA na organização do token; segredo cifrado, nunca no banco em claro, no audit nem na resposta", async () => {
    const db = bancoFalso({ automation_rules: () => regra }, cifra);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/automation-rules/route");
    const res = await POST(req(base, "POST", { ...corpo, is_active: true, organization_id: ORG_OUTRA }));
    expect(res.status).toBe(201);
    const insert = db.chamadas.find((c) => c.tabela === "automation_rules" && c.op === "insert");
    expect(insert?.patch).toMatchObject({ organization_id: ORG_TOKEN, created_by_user_id: DONO });
    expect(insert?.patch).not.toHaveProperty("is_active");
    expect(JSON.stringify(insert?.patch)).not.toContain(SEGREDO);
    expect(JSON.stringify(insert?.patch)).toContain("secret_enc");
    expect(JSON.stringify(await res.json())).not.toContain("secret_enc");
    const a = vi.mocked(audit).mock.calls.find((c) => c[0].action === "automation.rule_created")?.[0];
    expect(a).toMatchObject({ organizationId: ORG_TOKEN, actorApiTokenId: TOKEN_ID, actorUserId: null });
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(SEGREDO);
  });

  it("POST: dados inválidos → 400; sem chave de cifra → 422 e nada gravado", async () => {
    const { POST } = await import("@/app/api/v1/automation-rules/route");
    comoToken("manager", ["mcp:write"]);
    const db = bancoFalso({ automation_rules: () => regra }, () => null);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    expect((await POST(req(base, "POST", { name: "x" }))).status).toBe(400);
    const sem = await POST(req(base, "POST", corpo));
    expect(sem.status).toBe(422);
    expect(db.chamadas.some((c) => c.op === "insert")).toBe(false);
  });

  it("PATCH/DELETE: papel e escopo; id inválido 400; outra organização 404 sem escrita; org do token no filtro", async () => {
    const { PATCH, DELETE } = await import("@/app/api/v1/automation-rules/[id]/route");
    const url = `${base}/${REGRA}`;
    comoToken("agent", ["mcp:write"]);
    expect((await PATCH(req(url, "PATCH", { name: "N" }), ctxDe({ id: REGRA }))).status).toBe(403);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: REGRA }))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: REGRA }))).status).toBe(403);

    comoToken("manager", ["mcp:write"]);
    expect((await PATCH(req(`${base}/xx`, "PATCH", {}), ctxDe({ id: "xx" }))).status).toBe(400);

    const fora = bancoFalso({ automation_rules: () => null });
    vi.mocked(createAdminClient).mockReturnValue(fora as never);
    expect((await PATCH(req(url, "PATCH", { name: "N" }), ctxDe({ id: REGRA }))).status).toBe(404);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: REGRA }))).status).toBe(404);
    expect(fora.chamadas.some((c) => c.op === "update" || c.op === "delete")).toBe(false);

    const db = bancoFalso({ automation_rules: (c) => (daOrg(c) ? [regra] : null) }, cifra);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const lig = await PATCH(req(url, "PATCH", { is_active: true }), ctxDe({ id: REGRA }));
    expect(lig.status).toBe(200);
    const upd = db.chamadas.find((c) => c.op === "update");
    expect(upd?.filtros).toMatchObject({ id: REGRA, organization_id: ORG_TOKEN });
    expect(upd?.patch).toMatchObject({ is_active: true, last_change_actor_kind: "system" });
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: REGRA }))).status).toBe(204);
    expect(db.chamadas.find((c) => c.op === "delete")?.filtros).toMatchObject({ id: REGRA, organization_id: ORG_TOKEN });
  });

  it("PATCH com actions: segredo em claro cifrado, fora do audit; o audit só diz que as ações mudaram", async () => {
    const db = bancoFalso({ automation_rules: () => [regra] }, cifra);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/automation-rules/[id]/route");
    const res = await PATCH(req(`${base}/${REGRA}`, "PATCH", { actions: corpo.actions }), ctxDe({ id: REGRA }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(db.chamadas.find((c) => c.op === "update")?.patch)).not.toContain(SEGREDO);
    const a = vi.mocked(audit).mock.calls.find((c) => c[0].action === "automation.rule_updated")?.[0];
    expect(a?.metadata).toMatchObject({ actions_changed: true });
    expect(JSON.stringify(a)).not.toContain(SEGREDO);
    expect(a).toMatchObject({ actorApiTokenId: TOKEN_ID });
  });
});


// ---------------------------------------------------------------------------
// distribuição de atendimento (settings/routing)
// ---------------------------------------------------------------------------

describe("distribuição de atendimento (settings/routing)", () => {
  const url = "/api/v1/settings/routing";
  const orgLinha = (settings: Record<string, unknown> = {}) => ({ id: ORG_TOKEN, settings });
  const daOrg = (c: Chamada) => c.filtros.id === ORG_TOKEN;
  const rpcOk = () => 1;

  it("o proxy deixa passar só o caminho exato (a sub-rota de canais fica na sessão)", () => {
    expect(isPublicPath(url)).toBe(true);
    expect(isPublicPath(`${url}/channels`)).toBe(false);
  });

  it("GET: 401 sem credencial; agent 403; sem mcp:read 403; agente de IA 403", async () => {
    const { GET } = await import("@/app/api/v1/settings/routing/route");
    expect((await GET(req(url, "GET", undefined, {}, false))).status).toBe(401);
    comoToken("agent", ["mcp:read"]);
    expect((await GET(req(url, "GET"))).status).toBe(403);
    comoToken("manager", ["mcp:write"]);
    expect((await GET(req(url, "GET"))).status).toBe(403);
    comoToken("admin", ["mcp:read"], "ai_agent");
    expect((await GET(req(url, "GET"))).status).toBe(403);
  });

  it("GET por token: lê SÓ a organização do token e aplica os defaults", async () => {
    const db = bancoFalso({
      organizations: (c) => (daOrg(c) ? orgLinha({ visibility_mode: "own" }) : orgLinha({ visibility_mode: "all" })),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:read"]);
    const { GET } = await import("@/app/api/v1/settings/routing/route");
    const res = await GET(req(`${url}?organization_id=${ORG_OUTRA}`, "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ mode: "manual", visibility_mode: "own" });
    expect(db.chamadas[0]!.filtros.id).toBe(ORG_TOKEN);
  });

  it("PATCH: piso manager (agent → 403); sem mcp:write 403; agente de IA 403", async () => {
    const { PATCH } = await import("@/app/api/v1/settings/routing/route");
    expect((await PATCH(req(url, "PATCH", { mode: "round_robin" }, {}, false))).status).toBe(401);
    comoToken("agent", ["mcp:write"]);
    expect((await PATCH(req(url, "PATCH", { mode: "round_robin" }))).status).toBe(403);
    comoToken("manager", ["mcp:read"]);
    expect((await PATCH(req(url, "PATCH", { mode: "round_robin" }))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await PATCH(req(url, "PATCH", { mode: "round_robin" }))).status).toBe(403);
  });

  it("PATCH por token: grava só na organização do TOKEN, preserva a visibilidade quando omitida, audit com o token", async () => {
    const db = bancoFalso({ organizations: (c) => (daOrg(c) ? orgLinha({ visibility_mode: "own" }) : null) }, rpcOk);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/settings/routing/route");
    const res = await PATCH(req(url, "PATCH", { mode: "round_robin", organization_id: ORG_OUTRA }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ mode: "round_robin", visibility_mode: "own" });
    expect(db.rpcs.map((r) => r.nome)).toEqual(["fn_atualizar_setting_da_organizacao"]);
    expect(db.rpcs[0]!.args).toMatchObject({ p_org: ORG_TOKEN, p_caminho: ["routing"] });
    expect(JSON.stringify(db.rpcs)).not.toContain(ORG_OUTRA);
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "routing.config_changed")?.[0]).toMatchObject({
      organizationId: ORG_TOKEN,
      actorApiTokenId: TOKEN_ID,
      actorUserId: null,
    });
  });

  it("PATCH com visibility_mode grava a segunda chave; valor inválido → 4xx sem escrita", async () => {
    const db = bancoFalso({ organizations: () => orgLinha() }, rpcOk);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/settings/routing/route");
    expect((await PATCH(req(url, "PATCH", { mode: "manual", visibility_mode: "own" }))).status).toBe(200);
    expect(db.rpcs.map((r) => r.args.p_caminho)).toEqual([["routing"], ["visibility_mode"]]);

    const ruim = bancoFalso({ organizations: () => orgLinha() }, rpcOk);
    vi.mocked(createAdminClient).mockReturnValue(ruim as never);
    const res = await PATCH(req(url, "PATCH", { mode: "manual", visibility_mode: "ninguem" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(ruim.rpcs).toEqual([]);
  });

  it("PATCH de organização inexistente → 404 sem escrita", async () => {
    const db = bancoFalso({ organizations: () => null }, rpcOk);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/settings/routing/route");
    expect((await PATCH(req(url, "PATCH", { mode: "manual" }))).status).toBe(404);
    expect(db.rpcs).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// material de conhecimento
// ---------------------------------------------------------------------------

describe("material de conhecimento (ai/knowledge/sources)", () => {
  const FONTE_ID = "88888888-8888-4888-8888-888888888888";
  const AGENTE_X = "99999999-9999-4999-8999-999999999999";
  const base = "/api/v1/ai/knowledge/sources";
  const fonte = {
    id: FONTE_ID,
    organization_id: ORG_TOKEN,
    source_type: "faq",
    name: "FAQ da loja",
    agent_id: null,
    status: "ready",
    is_active: true,
    source_metadata: {},
  };
  const daOrg = (c: Chamada) => c.filtros.organization_id === ORG_TOKEN;
  const faq = { source_type: "faq", name: "FAQ da loja", items: [{ question: "Prazo?", answer: "Dois dias." }] };

  it("o proxy deixa passar só a coleção e o UUID (upload, reindex e trechos ficam na sessão)", () => {
    expect(isPublicPath(base)).toBe(true);
    expect(isPublicPath(`${base}/${FONTE_ID}`)).toBe(true);
    expect(isPublicPath(`${base}/upload`)).toBe(false);
    expect(isPublicPath(`${base}/${FONTE_ID}/reindex`)).toBe(false);
    expect(isPublicPath(`${base}/${FONTE_ID}/trechos`)).toBe(false);
  });

  it("GET: sem credencial 401; sem mcp:read 403; agente de IA 403; chave lê só a organização dela", async () => {
    const { GET } = await import("@/app/api/v1/ai/knowledge/sources/route");
    expect((await GET(req(base, "GET", undefined, {}, false))).status).toBe(401);
    comoToken("admin", ["mcp:write"]);
    expect((await GET(req(base, "GET"))).status).toBe(403);
    comoToken("admin", ["mcp:read"], "ai_agent");
    expect((await GET(req(base, "GET"))).status).toBe(403);

    const db = bancoFalso({ ai_knowledge_sources: (c) => (daOrg(c) ? [fonte] : null) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("viewer", ["mcp:read"]);
    const res = await GET(req(`${base}?organization_id=${ORG_OUTRA}`, "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([fonte]);
    expect(db.chamadas[0]!.filtros.organization_id).toBe(ORG_TOKEN);
  });

  it("POST: piso manager (agent → 403); sem mcp:write 403; agente de IA 403; 401 sem credencial", async () => {
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    expect((await POST(req(base, "POST", faq, {}, false))).status).toBe(401);
    comoToken("agent", ["mcp:write"]);
    expect((await POST(req(base, "POST", faq))).status).toBe(403);
    comoToken("manager", ["mcp:read"]);
    expect((await POST(req(base, "POST", faq))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await POST(req(base, "POST", faq))).status).toBe(403);
  });

  it("POST FAQ por token: grava na organização do TOKEN (body com organization_id é ignorado), itens e audit com o token", async () => {
    const db = bancoFalso({ ai_knowledge_sources: () => ({ id: FONTE_ID }), ai_faq_items: () => [] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    const res = await POST(req(base, "POST", { ...faq, organization_id: ORG_OUTRA }));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ id: FONTE_ID, items_count: 1 });
    const fonteInserida = db.chamadas.find((c) => c.tabela === "ai_knowledge_sources" && c.op === "insert");
    expect(fonteInserida?.patch).toMatchObject({ organization_id: ORG_TOKEN, source_type: "faq" });
    const itens = db.chamadas.find((c) => c.tabela === "ai_faq_items" && c.op === "insert");
    expect(JSON.stringify(itens?.patch)).toContain(ORG_TOKEN);
    expect(JSON.stringify([fonteInserida?.patch, itens?.patch])).not.toContain(ORG_OUTRA);
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === "ai.knowledge_source_created")?.[0]).toMatchObject({
      organizationId: ORG_TOKEN,
      actorApiTokenId: TOKEN_ID,
      actorUserId: null,
    });
  });

  it("POST: tipo desconhecido 422; sem conteúdo 400; nome repetido 409; agente de OUTRA organização 404; blob_path alheio 422 — sem inserir", async () => {
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    comoToken("manager", ["mcp:write"]);
    const db = bancoFalso({
      ai_knowledge_sources: () => ({ __erro: { code: "23505", message: "dup" } }),
      ai_agents: (c) => (daOrg(c) ? null : [{ id: AGENTE_X }]),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    expect((await POST(req(base, "POST", { ...faq, source_type: "inventado" }))).status).toBe(422);
    expect((await POST(req(base, "POST", { source_type: "faq", name: "Sem nada" }))).status).toBe(400);
    expect((await POST(req(base, "POST", { ...faq, agent_id: AGENTE_X }))).status).toBe(404);
    expect(
      (await POST(req(base, "POST", { ...faq, source_metadata: { blob_path: `${ORG_OUTRA}/arquivo.md` } }))).status,
    ).toBe(422);
    expect(db.chamadas.some((c) => c.op === "insert")).toBe(false);
    expect((await POST(req(base, "POST", faq))).status).toBe(409);
  });

  it("GET/PATCH/DELETE /[id]: id inválido 400; outra organização 404 sem escrita; escrita filtra pela organização do token", async () => {
    const { GET, PATCH, DELETE } = await import("@/app/api/v1/ai/knowledge/sources/[id]/route");
    const url = `${base}/${FONTE_ID}`;
    comoToken("agent", ["mcp:read", "mcp:write"]);
    expect((await GET(req(url, "GET"), ctxDe({ id: FONTE_ID }))).status).toBe(403);
    expect((await PATCH(req(url, "PATCH", { name: "Novo nome" }), ctxDe({ id: FONTE_ID }))).status).toBe(403);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: FONTE_ID }))).status).toBe(403);

    comoToken("manager", ["mcp:read", "mcp:write"]);
    expect((await GET(req(`${base}/xx`, "GET"), ctxDe({ id: "xx" }))).status).toBe(400);

    const fora = bancoFalso({ ai_knowledge_sources: () => null });
    vi.mocked(createAdminClient).mockReturnValue(fora as never);
    expect((await GET(req(url, "GET"), ctxDe({ id: FONTE_ID }))).status).toBe(404);
    expect((await PATCH(req(url, "PATCH", { name: "Novo nome" }), ctxDe({ id: FONTE_ID }))).status).toBe(404);
    expect((await DELETE(req(url, "DELETE"), ctxDe({ id: FONTE_ID }))).status).toBe(404);
    expect(fora.chamadas.some((c) => c.op === "update" || c.op === "delete" || c.op === "insert")).toBe(false);

    const db = bancoFalso({ ai_knowledge_sources: (c) => (daOrg(c) ? [fonte] : null), ai_faq_items: () => [] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const edit = await PATCH(
      req(url, "PATCH", { name: "Novo nome", items: [{ question: "Q?", answer: "A." }] }),
      ctxDe({ id: FONTE_ID }),
    );
    expect(edit.status).toBe(200);
    const escritas = db.chamadas.filter((c) => c.op !== "select");
    expect(escritas.every((c) => c.filtros.organization_id === ORG_TOKEN || c.tabela === "ai_faq_items")).toBe(true);
    expect(escritas.find((c) => c.tabela === "ai_knowledge_sources" && c.op === "update")?.filtros).toMatchObject({
      id: FONTE_ID,
      organization_id: ORG_TOKEN,
    });
    const arq = await DELETE(req(url, "DELETE"), ctxDe({ id: FONTE_ID }));
    expect(arq.status).toBe(200);
    const arquivou = db.chamadas.filter((c) => c.op === "update").at(-1);
    expect(arquivou?.patch).toMatchObject({ status: "archived", is_active: false });
    expect(arquivou?.filtros).toMatchObject({ id: FONTE_ID, organization_id: ORG_TOKEN });
    const acoes = vi.mocked(audit).mock.calls.map((c) => c[0].action);
    expect(acoes).toEqual(expect.arrayContaining(["ai.knowledge_source_updated", "ai.knowledge_source_archived"]));
  });

  it("PATCH com blob_path de outra organização → 422 sem escrita", async () => {
    const db = bancoFalso({ ai_knowledge_sources: () => [fonte] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { PATCH } = await import("@/app/api/v1/ai/knowledge/sources/[id]/route");
    const res = await PATCH(
      req(`${base}/${FONTE_ID}`, "PATCH", { source_metadata: { blob_path: `${ORG_OUTRA}/x.md` } }),
      ctxDe({ id: FONTE_ID }),
    );
    expect(res.status).toBe(422);
    expect(db.chamadas.some((c) => c.op === "update")).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// conexões de canal e credenciais de IA (só leitura por token)
// ---------------------------------------------------------------------------

describe("conexões de canal e credenciais de IA — só leitura por token", () => {
  const canal = {
    id: "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1",
    provider: "waha",
    waha_session_name: "org_a_1",
    display_name: "Comercial",
    phone_number: "5511999999999",
    status: "WORKING",
  };
  const credencial = {
    id: "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
    organization_id: ORG_TOKEN,
    provider: "openai",
    label: "Chave principal",
    api_key_last4: "9f3a",
    base_url: null,
    validated_at: "2026-10-17T00:00:00Z",
    validation_error: null,
    models_available: ["gpt"],
    is_active: true,
    created_by: DONO,
  };
  const daOrg = (c: Chamada) => c.filtros.organization_id === ORG_TOKEN;

  it("o proxy deixa passar só os dois caminhos exatos (as sub-rotas de escrita ficam na sessão)", () => {
    expect(isPublicPath("/api/v1/channel-sessions")).toBe(true);
    expect(isPublicPath("/api/v1/ai/credentials")).toBe(true);
    expect(isPublicPath(`/api/v1/channel-sessions/${canal.id}`)).toBe(false);
    expect(isPublicPath(`/api/v1/channel-sessions/${canal.id}/qr`)).toBe(false);
    expect(isPublicPath(`/api/v1/ai/credentials/${credencial.id}`)).toBe(false);
    expect(isPublicPath("/api/v1/ai/credentials/test")).toBe(false);
  });

  it("escrita por token não existe: POST em channel-sessions e credentials responde 401 pelo caminho da sessão", async () => {
    const { POST: criarCanal } = await import("@/app/api/v1/channel-sessions/route");
    const { POST: criarChave } = await import("@/app/api/v1/ai/credentials/route");
    comoToken("admin", ["mcp:write", "mcp:read"]);
    // O Bearer não é reconhecido nessas rotas: caem em `requireRole` (sessão), que aqui é "ninguém logado".
    expect((await criarCanal(req("/api/v1/channel-sessions", "POST", { display_name: "X" }))).status).toBe(401);
    expect((await criarChave(req("/api/v1/ai/credentials", "POST", { provider: "openai", label: "x", api_key: "sk-1234567890" }))).status).toBe(401);
  });

  it("channel-sessions GET: sem credencial 401; sem mcp:read 403; agente de IA 403; chave lê só a organização dela, sem segredo", async () => {
    const { GET } = await import("@/app/api/v1/channel-sessions/route");
    expect((await GET(req("/api/v1/channel-sessions", "GET", undefined, {}, false))).status).toBe(401);
    comoToken("admin", ["mcp:write"]);
    expect((await GET(req("/api/v1/channel-sessions", "GET"))).status).toBe(403);
    comoToken("admin", ["mcp:read"], "ai_agent");
    expect((await GET(req("/api/v1/channel-sessions", "GET"))).status).toBe(403);

    const db = bancoFalso({ channel_sessions: (c) => (daOrg(c) ? [canal] : null) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("viewer", ["mcp:read"]);
    const res = await GET(req(`/api/v1/channel-sessions?organization_id=${ORG_OUTRA}`, "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([canal]);
    expect(db.chamadas[0]!.filtros.organization_id).toBe(ORG_TOKEN);
    const colunas = JSON.stringify(db.chamadas);
    expect(colunas).not.toMatch(/token|secret|webhook/i);
  });

  it("ai/credentials GET: manager+mcp:read; viewer 403; agente de IA 403; chave NÃO recebe os 4 últimos da chave nem o autor; a sessão recebe", async () => {
    const { GET } = await import("@/app/api/v1/ai/credentials/route");
    const url = "/api/v1/ai/credentials";
    expect((await GET(req(url, "GET", undefined, {}, false))).status).toBe(401);
    comoToken("viewer", ["mcp:read"]);
    expect((await GET(req(url, "GET"))).status).toBe(403);
    comoToken("admin", ["mcp:read"], "ai_agent");
    expect((await GET(req(url, "GET"))).status).toBe(403);

    const db = bancoFalso({ ai_provider_credentials_safe: (c) => (daOrg(c) ? [credencial] : null) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:read"]);
    const res = await GET(req(`${url}?organization_id=${ORG_OUTRA}`, "GET"));
    expect(res.status).toBe(200);
    const corpo = JSON.stringify((await res.json()).data);
    expect(corpo).toContain(credencial.id);
    expect(corpo).not.toContain("api_key_last4");
    expect(corpo).not.toContain("9f3a");
    expect(corpo).not.toContain("created_by");
    expect(db.chamadas[0]!.filtros.organization_id).toBe(ORG_TOKEN);

    const sessao = bancoFalso({ ai_provider_credentials_safe: () => [credencial] });
    vi.mocked(createClient).mockResolvedValue(sessao as never);
    comoSessao("manager");
    const daTela = await GET(req(url, "GET", undefined, {}, false));
    expect(JSON.stringify((await daTela.json()).data)).toContain("9f3a");
  });
});
