/**
 * API fase 2 (17/10/2026): segredo HMAC das entradas automáticas, campos personalizados do funil e
 * agentes de IA — por token `Authorization: Bearer dsk_…`.
 *
 * O que se prova, pelo comportamento das rotas (só a borda é falsa: banco, autenticador de token,
 * sessão): sem credencial → 401; papel/escopo abaixo do piso da tela → 403; token de agente de IA →
 * 403; organização SEMPRE a do token (id de outra organização responde 404 e nada é escrito); audit
 * carrega o token; o segredo em claro aparece só na resposta que o gerou e nunca no banco, no audit
 * nem no recibo de idempotência.
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

const ORG_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_OUTRA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DONO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FUNIL = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FONTE = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";
const AGENTE = "33333333-3333-4333-8333-333333333333";
const VERSAO = "44444444-4444-4444-8444-444444444444";
const CREDENCIAL = "55555555-5555-4555-8555-555555555555";

interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update" | "delete";
  filtros: Record<string, unknown>;
  patch?: unknown;
}

/**
 * Banco falso: registra cada operação com seus `.eq()`, devolve a linha da tabela e, em
 * `single()/maybeSingle()`, desembrulha lista em primeiro item (como o PostgREST).
 */
function bancoFalso(linhas: Record<string, (c: Chamada) => unknown>, rpc?: (nome: string, args: unknown) => unknown) {
  const chamadas: Chamada[] = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const from = (tabela: string) => {
    const c: Chamada = { tabela, op: "select", filtros: {} };
    const resolver = (unico: boolean) => {
      chamadas.push({ ...c, filtros: { ...c.filtros } });
      let dado = linhas[tabela]?.(c) ?? null;
      if (unico && Array.isArray(dado)) dado = dado[0] ?? null;
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
      is: () => chain,
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
  return {
    from,
    chamadas,
    rpcs,
    // D-204: criar entrada automática confere o e-mail provado da conta no provedor (conta sem pedido em aberto passa).
    auth: { admin: { getUserById: async () => ({ data: { user: { id: DONO, app_metadata: {} } }, error: null }) } },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      return { data: rpc ? rpc(nome, args) : null, error: null };
    },
  };
}

function comoToken(role: Role, scopes: string[], actorType: "api_token" | "ai_agent" = "api_token") {
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

function req(url: string, method: string, body?: unknown, headers: Record<string, string> = {}, bearer = true) {
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

const ctxDe = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks();
  // Sem Bearer, cai na sessão — e a sessão aqui é "ninguém logado".
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: { code: "unauthenticated" } }), { status: 401 }),
  } as never);
});

// ---------------------------------------------------------------------------
// segredo HMAC da entrada automática
// ---------------------------------------------------------------------------

const fonteDoBanco = {
  id: FONTE,
  organization_id: ORG_TOKEN,
  name: "Site",
  is_active: true,
  kind: "generic",
  path_token: "tok_publico",
  default_pipeline_id: FUNIL,
  default_stage_id: ETAPA,
  redirect_to: null,
  field_map: {},
  last_received_at: null,
  secret_encrypted: "\\xvelho",
  created_at: "2026-10-17T00:00:00Z",
  updated_at: "2026-10-17T00:00:00Z",
  last_change_actor_kind: null,
  last_change_at: null,
};

describe("POST /webhook-sources/[id]/rotate-secret", () => {
  const url = `/api/v1/webhook-sources/${FONTE}/rotate-secret`;

  it("sem token e sem sessão → 401; agent → 403; manager sem mcp:write → 403", async () => {
    const { POST } = await import("@/app/api/v1/webhook-sources/[id]/rotate-secret/route");
    expect((await POST(req(url, "POST", undefined, {}, false), ctxDe({ id: FONTE }))).status).toBe(401);

    comoToken("agent", ["mcp:write"]);
    expect((await POST(req(url, "POST"), ctxDe({ id: FONTE }))).status).toBe(403);

    comoToken("manager", ["mcp:read"]);
    expect((await POST(req(url, "POST"), ctxDe({ id: FONTE }))).status).toBe(403);
  });

  it("token inválido/revogado → 401 antes de qualquer leitura", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token revoked."));
    const { POST } = await import("@/app/api/v1/webhook-sources/[id]/rotate-secret/route");
    expect((await POST(req(url, "POST"), ctxDe({ id: FONTE }))).status).toBe(401);
  });

  it("token de AGENTE DE IA não administra → 403", async () => {
    comoToken("admin", ["mcp:write"], "ai_agent");
    const { POST } = await import("@/app/api/v1/webhook-sources/[id]/rotate-secret/route");
    expect((await POST(req(url, "POST"), ctxDe({ id: FONTE }))).status).toBe(403);
  });

  it("entrada de OUTRA organização → 404, nenhum segredo gerado nem escrito", async () => {
    const db = bancoFalso({ webhook_sources: (c) => (c.filtros.organization_id === ORG_OUTRA ? [fonteDoBanco] : null) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/[id]/rotate-secret/route");
    const res = await POST(req(url, "POST", { organization_id: ORG_OUTRA }), ctxDe({ id: FONTE }));
    expect(res.status).toBe(404);
    expect(db.chamadas.every((c) => c.filtros.organization_id === ORG_TOKEN)).toBe(true);
    expect(db.chamadas.some((c) => c.op === "update")).toBe(false);
    expect(db.rpcs).toEqual([]);
  });

  it("gira: o texto claro volta UMA vez; no banco só o cifrado; o audit não leva o segredo e leva o token", async () => {
    const db = bancoFalso(
      {
        webhook_sources: (c) => (c.filtros.organization_id === ORG_TOKEN ? [fonteDoBanco] : null),
      },
      (nome) => (nome === "fn_encrypt_oauth" ? "\\xcifrado" : null),
    );
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/[id]/rotate-secret/route");
    const res = await POST(req(url, "POST"), ctxDe({ id: FONTE }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const corpo = (await res.json()).data;
    expect(corpo.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(corpo.secret_shown_once).toBe(true);
    expect(corpo.has_secret).toBe(true);
    expect(corpo).not.toHaveProperty("secret_encrypted");

    // O que foi cifrado é o MESMO texto que voltou; o que foi gravado é só o cifrado.
    expect(db.rpcs[0]).toMatchObject({ nome: "fn_encrypt_oauth", args: { plaintext: corpo.secret } });
    const escrita = db.chamadas.find((c) => c.op === "update");
    expect(escrita?.filtros).toMatchObject({ id: FONTE, organization_id: ORG_TOKEN });
    expect(escrita?.patch).toMatchObject({ secret_encrypted: "\\xcifrado" });
    expect(JSON.stringify(escrita?.patch)).not.toContain(corpo.secret);

    const chamadaDeAudit = vi.mocked(audit).mock.calls.find((c) => c[0].action === "webhook.source_secret_rotated");
    expect(chamadaDeAudit?.[0]).toMatchObject({ organizationId: ORG_TOKEN, actorApiTokenId: TOKEN_ID, actorUserId: null });
    expect(JSON.stringify(chamadaDeAudit)).not.toContain(corpo.secret);
  });

  it("sem chave de cifra na instalação → 422 e nada é escrito", async () => {
    const db = bancoFalso({ webhook_sources: () => [fonteDoBanco] }, () => null);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/[id]/rotate-secret/route");
    const res = await POST(req(url, "POST"), ctxDe({ id: FONTE }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("encryption_unavailable");
    expect(db.chamadas.some((c) => c.op === "update")).toBe(false);
  });
});

describe("POST /webhook-sources com generate_secret e Idempotency-Key", () => {
  const corpo = { name: "Site", default_pipeline_id: FUNIL, default_stage_id: ETAPA, generate_secret: true };

  function bancoDeCriacao() {
    return bancoFalso(
      {
        crm_pipelines: () => ({ id: FUNIL }),
        crm_stages: () => ({ id: ETAPA, is_archived: false }),
        webhook_sources: (c) => (c.op === "insert" ? fonteDoBanco : [{ id: FONTE, path_token: "tok_publico" }]),
        idempotency_keys: () => null,
      },
      (nome) => (nome === "fn_encrypt_oauth" ? "\\xcifrado" : null),
    );
  }

  it("segredo gerado volta na criação, mas NÃO entra no recibo de idempotência", async () => {
    const db = bancoDeCriacao();
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/route");
    const res = await POST(req("/api/v1/webhook-sources", "POST", corpo, { "Idempotency-Key": "9f0e6c1e-3b0a-4b8e-9d55-0a1b2c3d4e5f" }));
    expect(res.status).toBe(201);
    const dados = (await res.json()).data;
    expect(dados.secret).toMatch(/^[0-9a-f]{64}$/);

    const recibo = db.chamadas.filter((c) => c.tabela === "idempotency_keys" && c.op === "update");
    expect(recibo.length).toBeGreaterThan(0);
    expect(JSON.stringify(recibo)).not.toContain(dados.secret);
    expect(JSON.stringify(recibo)).toContain("has_secret");
    expect(recibo.every((c) => c.filtros.organization_id === ORG_TOKEN)).toBe(true);
  });

  it("generate_secret junto com secret → 400; Idempotency-Key que não é UUID → 400", async () => {
    const db = bancoDeCriacao();
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/route");
    const dois = await POST(req("/api/v1/webhook-sources", "POST", { ...corpo, secret: "x".repeat(20) }));
    expect(dois.status).toBe(400);
    const ruim = await POST(req("/api/v1/webhook-sources", "POST", corpo, { "Idempotency-Key": "nao-e-uuid" }));
    expect(ruim.status).toBe(400);
    expect(db.chamadas.some((c) => c.tabela === "webhook_sources" && c.op === "insert")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recibo de idempotência: nada de acesso nele (achados da auditoria da fase 2)
// ---------------------------------------------------------------------------

describe("POST /webhook-sources — o recibo não guarda path_token nem o segredo digitado", () => {
  const CHAVE = "9f0e6c1e-3b0a-4b8e-9d55-0a1b2c3d4e5f";
  const url = "/api/v1/webhook-sources";
  const corpo = { name: "Site", default_pipeline_id: FUNIL, default_stage_id: ETAPA };

  function bancoDeCriacao(extra: Record<string, (c: Chamada) => unknown> = {}) {
    return bancoFalso(
      {
        crm_pipelines: () => ({ id: FUNIL }),
        crm_stages: () => ({ id: ETAPA, is_archived: false }),
        webhook_sources: (c) => (c.op === "insert" ? fonteDoBanco : [{ id: FONTE, path_token: "tok_publico" }]),
        idempotency_keys: () => null,
        ...extra,
      },
      (nome) => (nome === "fn_encrypt_oauth" ? "\\xcifrado" : null),
    );
  }
  const insercaoDoRecibo = (db: ReturnType<typeof bancoFalso>) =>
    db.chamadas.find((c) => c.tabela === "idempotency_keys" && c.op === "insert");
  const recibos = (db: ReturnType<typeof bancoFalso>) =>
    db.chamadas.filter((c) => c.tabela === "idempotency_keys" && c.op !== "select");

  it("path_token vai na resposta ao vivo e fica FORA do recibo gravado", async () => {
    const db = bancoDeCriacao();
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/route");
    const res = await POST(req(url, "POST", corpo, { "Idempotency-Key": CHAVE }));
    expect(res.status).toBe(201);
    const dados = (await res.json()).data;
    expect(typeof dados.path_token).toBe("string");
    expect(dados.path_token.length).toBeGreaterThan(10);
    expect(JSON.stringify(recibos(db))).not.toContain(dados.path_token);
    expect(recibos(db).every((c) => c.filtros.organization_id === undefined || c.filtros.organization_id === ORG_TOKEN)).toBe(true);
  });

  it("replay: o servidor recoloca o path_token lido do banco, na organização do token, sem criar de novo", async () => {
    const primeiro = bancoDeCriacao();
    vi.mocked(createAdminClient).mockReturnValue(primeiro as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/route");
    await POST(req(url, "POST", corpo, { "Idempotency-Key": CHAVE }));
    const hash = (insercaoDoRecibo(primeiro)?.patch as { request_hash: string }).request_hash;

    const segundo = bancoDeCriacao({
      idempotency_keys: (c) =>
        c.op === "select"
          ? [
              {
                id: "r1",
                request_hash: hash,
                status_code: 201,
                expires_at: "2099-01-01T00:00:00Z",
                response_body: { id: FONTE, name: "Site", has_secret: false },
              },
            ]
          : null,
      webhook_sources: (c) => (c.op === "select" ? [{ path_token: "tok_do_banco" }] : fonteDoBanco),
    });
    vi.mocked(createAdminClient).mockReturnValue(segundo as never);
    const res = await POST(req(url, "POST", corpo, { "Idempotency-Key": CHAVE }));
    expect(res.status).toBe(201);
    const dados = (await res.json()).data;
    expect(dados).toMatchObject({ id: FONTE, path_token: "tok_do_banco" });
    expect(segundo.chamadas.some((c) => c.tabela === "webhook_sources" && c.op === "insert")).toBe(false);
    const leitura = segundo.chamadas.find((c) => c.tabela === "webhook_sources" && c.op === "select");
    expect(leitura?.filtros).toMatchObject({ id: FONTE, organization_id: ORG_TOKEN });
  });

  it("o segredo DIGITADO não entra no hash do recibo: dois segredos, mesmo hash; e não aparece no recibo", async () => {
    const hashCom = async (segredo: string) => {
      const db = bancoDeCriacao();
      vi.mocked(createAdminClient).mockReturnValue(db as never);
      comoToken("manager", ["mcp:write"]);
      const { POST } = await import("@/app/api/v1/webhook-sources/route");
      const res = await POST(req(url, "POST", { ...corpo, secret: segredo }, { "Idempotency-Key": CHAVE }));
      expect(res.status).toBe(201);
      expect(JSON.stringify(recibos(db))).not.toContain(segredo);
      return (insercaoDoRecibo(db)?.patch as { request_hash: string }).request_hash;
    };
    const a = await hashCom("segredo-digitado-AAAAAAAAAAAA");
    const b = await hashCom("segredo-digitado-BBBBBBBBBBBB");
    expect(a).toBe(b);
    // E é diferente do pedido SEM segredo: o marcador `has_secret` ainda distingue as duas operações.
    const sem = bancoDeCriacao();
    vi.mocked(createAdminClient).mockReturnValue(sem as never);
    const { POST } = await import("@/app/api/v1/webhook-sources/route");
    await POST(req(url, "POST", corpo, { "Idempotency-Key": CHAVE }));
    expect((insercaoDoRecibo(sem)?.patch as { request_hash: string }).request_hash).not.toBe(a);
  });

  it("Cache-Control: no-store em toda criação (path_token), com ou sem segredo gerado, e no replay", async () => {
    const db = bancoDeCriacao();
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/route");
    const comSegredo = await POST(req(url, "POST", { ...corpo, generate_secret: true }));
    expect(comSegredo.status).toBe(201);
    expect(comSegredo.headers.get("cache-control")).toBe("no-store");
    expect((await comSegredo.json()).data.secret).toMatch(/^[0-9a-f]{64}$/);

    const semSegredo = await POST(req(url, "POST", corpo));
    expect(semSegredo.status).toBe(201);
    // O `path_token` é a chave da URL de captação: vai em toda 201, e nenhuma pode ser cacheada.
    expect((await semSegredo.clone().json()).data.path_token).toEqual(expect.any(String));
    expect(semSegredo.headers.get("cache-control")).toBe("no-store");
  });

  it("o replay (mesma Idempotency-Key) também sai com no-store", async () => {
    const primeiro = bancoDeCriacao();
    vi.mocked(createAdminClient).mockReturnValue(primeiro as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/route");
    await POST(req(url, "POST", corpo, { "Idempotency-Key": CHAVE }));
    const hash = (insercaoDoRecibo(primeiro)?.patch as { request_hash: string }).request_hash;

    const segundo = bancoDeCriacao({
      idempotency_keys: (c) =>
        c.op === "select"
          ? [
              {
                id: "r1",
                request_hash: hash,
                status_code: 201,
                expires_at: "2099-01-01T00:00:00Z",
                response_body: { id: FONTE, name: "Site", has_secret: false },
              },
            ]
          : null,
      webhook_sources: (c) => (c.op === "select" ? [{ path_token: "tok_do_banco" }] : fonteDoBanco),
    });
    vi.mocked(createAdminClient).mockReturnValue(segundo as never);
    const res = await POST(req(url, "POST", corpo, { "Idempotency-Key": CHAVE }));
    expect(res.status).toBe(201);
    expect((await res.json()).data.path_token).toBe("tok_do_banco");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a mesma Idempotency-Key vinda de OUTRO token da organização é 409, nunca o replay", async () => {
    const primeiro = bancoDeCriacao();
    vi.mocked(createAdminClient).mockReturnValue(primeiro as never);
    comoToken("manager", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/webhook-sources/route");
    await POST(req(url, "POST", corpo, { "Idempotency-Key": CHAVE }));
    const hash = (insercaoDoRecibo(primeiro)?.patch as { request_hash: string }).request_hash;

    const segundo = bancoDeCriacao({
      idempotency_keys: (c) =>
        c.op === "select"
          ? [
              {
                id: "r1",
                request_hash: hash,
                status_code: 201,
                expires_at: "2099-01-01T00:00:00Z",
                response_body: { id: FONTE, name: "Site", has_secret: false },
              },
            ]
          : null,
      webhook_sources: (c) => (c.op === "select" ? [{ path_token: "tok_do_banco" }] : fonteDoBanco),
    });
    vi.mocked(createAdminClient).mockReturnValue(segundo as never);
    // Outro token, mesma organização, mesmo corpo, mesma chave.
    vi.mocked(validateBearerToken).mockResolvedValueOnce({
      organizationId: ORG_TOKEN,
      role: "manager",
      actor: { type: "api_token", id: "99999999-9999-4999-8999-999999999999", role: "manager" },
      apiTokenId: "99999999-9999-4999-8999-999999999999",
      scopes: ["mcp:write"],
      createdBy: DONO,
    } as never);
    const res = await POST(req(url, "POST", corpo, { "Idempotency-Key": CHAVE }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("idempotency_conflict");
  });
});

// ---------------------------------------------------------------------------
// campos personalizados do funil
// ---------------------------------------------------------------------------

describe("campos personalizados do funil", () => {
  const base = `/api/v1/pipelines/${FUNIL}/fields`;
  const existente = { key: "origem", label: "Origem", type: "text" };

  function bancoDoFunil(fields: unknown[] = [existente]) {
    return bancoFalso({
      crm_pipelines: (c) =>
        c.filtros.organization_id !== ORG_TOKEN
          ? null
          : c.op === "update"
            ? [{ id: FUNIL }]
            : { id: FUNIL, name: "Vendas", vocabulary: {}, settings: { fields }, updated_at: "2026-10-17T00:00:00Z" },
      crm_stages: (c) => (c.op === "select" ? [{ id: ETAPA }] : null),
    });
  }

  it("GET: manager+mcp:read lê; agent leva 403; funil de outra organização → 404", async () => {
    const { GET } = await import("@/app/api/v1/pipelines/[id]/fields/route");
    vi.mocked(createAdminClient).mockReturnValue(bancoDoFunil() as never);
    comoToken("manager", ["mcp:read"]);
    const ok = await GET(req(base, "GET"), ctxDe({ id: FUNIL }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toEqual([existente]);

    comoToken("agent", ["mcp:read"]);
    expect((await GET(req(base, "GET"), ctxDe({ id: FUNIL }))).status).toBe(403);

    vi.mocked(createAdminClient).mockReturnValue(bancoFalso({ crm_pipelines: () => null }) as never);
    comoToken("manager", ["mcp:read"]);
    expect((await GET(req(base, "GET"), ctxDe({ id: FUNIL }))).status).toBe(404);
  });

  it("POST: piso é admin (manager → 403); sem credencial → 401", async () => {
    const { POST } = await import("@/app/api/v1/pipelines/[id]/fields/route");
    const novo = { key: "orcamento", label: "Orçamento", type: "number" };
    comoToken("manager", ["mcp:write"]);
    expect((await POST(req(base, "POST", novo), ctxDe({ id: FUNIL }))).status).toBe(403);
    comoToken("admin", ["mcp:read"]);
    expect((await POST(req(base, "POST", novo), ctxDe({ id: FUNIL }))).status).toBe(403);
    expect((await POST(req(base, "POST", novo, {}, false), ctxDe({ id: FUNIL }))).status).toBe(401);
  });

  it("POST acrescenta SEM apagar os campos que já existem; org do token no filtro; audit leva o token", async () => {
    const db = bancoDoFunil([existente]);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/pipelines/[id]/fields/route");
    const novo = { key: "orcamento", label: "Orçamento", type: "number", obrigatorio_em: { etapas: [ETAPA], ao_ganhar: true } };
    const res = await POST(req(base, "POST", novo), ctxDe({ id: FUNIL }));
    expect(res.status).toBe(201);
    const escrita = db.chamadas.find((c) => c.tabela === "crm_pipelines" && c.op === "update");
    expect(escrita?.filtros).toMatchObject({ id: FUNIL, organization_id: ORG_TOKEN });
    expect((escrita?.patch as { settings: { fields: unknown[] } }).settings.fields).toEqual([existente, novo]);
    // A etapa citada foi conferida contra ESTE funil e esta organização.
    const conferencia = db.chamadas.find((c) => c.tabela === "crm_stages");
    expect(conferencia?.filtros).toMatchObject({ organization_id: ORG_TOKEN, pipeline_id: FUNIL });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.config_updated",
        organizationId: ORG_TOKEN,
        actorApiTokenId: TOKEN_ID,
        metadata: expect.objectContaining({ campo_chave: "orcamento", campo_acao: "criado" }),
      }),
    );
  });

  it("POST recusa: chave repetida sem diferenciar maiúsculas (409), select sem opções (422), etapa de outro funil (422), corpo com campo desconhecido (422)", async () => {
    const { POST } = await import("@/app/api/v1/pipelines/[id]/fields/route");
    comoToken("admin", ["mcp:write"]);

    let db = bancoDoFunil();
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    expect((await POST(req(base, "POST", { key: "ORIGEM", label: "x", type: "text" }), ctxDe({ id: FUNIL }))).status).toBe(409);
    expect((await POST(req(base, "POST", { key: "porte", label: "Porte", type: "select" }), ctxDe({ id: FUNIL }))).status).toBe(422);
    expect(
      (await POST(req(base, "POST", { key: "porte", label: "Porte", type: "text", options: [{ value: "a", label: "A" }] }), ctxDe({ id: FUNIL }))).status,
    ).toBe(422);
    expect((await POST(req(base, "POST", { key: "x", label: "X", type: "text", organization_id: ORG_OUTRA }), ctxDe({ id: FUNIL }))).status).toBe(422);

    db = bancoFalso({
      crm_pipelines: () => ({ id: FUNIL, name: "V", vocabulary: {}, settings: { fields: [] } }),
      crm_stages: () => [], // a etapa não é deste funil
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const res = await POST(
      req(base, "POST", { key: "x", label: "X", type: "text", obrigatorio_em: { etapas: [ETAPA] } }),
      ctxDe({ id: FUNIL }),
    );
    expect(res.status).toBe(422);
    expect(db.chamadas.some((c) => c.op === "update")).toBe(false);
  });

  it("POST com Idempotency-Key: o recibo é escopado pela organização e pelo funil", async () => {
    const db = bancoFalso({
      crm_pipelines: (c) => (c.op === "update" ? [{ id: FUNIL }] : { id: FUNIL, name: "V", vocabulary: {}, settings: { fields: [] } }),
      idempotency_keys: () => null,
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/pipelines/[id]/fields/route");
    const res = await POST(
      req(base, "POST", { key: "x", label: "X", type: "text" }, { "Idempotency-Key": "9f0e6c1e-3b0a-4b8e-9d55-0a1b2c3d4e5f" }),
      ctxDe({ id: FUNIL }),
    );
    expect(res.status).toBe(201);
    const reserva = db.chamadas.find((c) => c.tabela === "idempotency_keys" && c.op === "insert");
    expect(reserva?.patch).toMatchObject({ organization_id: ORG_TOKEN, endpoint: base });
  });

  it("PATCH altera um campo (type não muda: 422), campo inexistente → 404, DELETE remove só ele", async () => {
    const { PATCH, DELETE } = await import("@/app/api/v1/pipelines/[id]/fields/[key]/route");
    const outro = { key: "porte", label: "Porte", type: "text" };
    const db = bancoDoFunil([existente, outro]);
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);

    const mudaTipo = await PATCH(req(`${base}/origem`, "PATCH", { type: "number" }), ctxDe({ id: FUNIL, key: "origem" }));
    expect(mudaTipo.status).toBe(422);

    const ok = await PATCH(req(`${base}/origem`, "PATCH", { label: "De onde veio", required: true }), ctxDe({ id: FUNIL, key: "origem" }));
    expect(ok.status).toBe(200);
    const patch = db.chamadas.filter((c) => c.tabela === "crm_pipelines" && c.op === "update").at(-1)?.patch as {
      settings: { fields: unknown[] };
    };
    expect(patch.settings.fields).toEqual([{ ...existente, label: "De onde veio", required: true }, outro]);

    const inexistente = await PATCH(req(`${base}/nao_existe`, "PATCH", { label: "x" }), ctxDe({ id: FUNIL, key: "nao_existe" }));
    expect(inexistente.status).toBe(404);

    const remove = await DELETE(req(`${base}/origem`, "DELETE"), ctxDe({ id: FUNIL, key: "origem" }));
    expect(remove.status).toBe(200);
    const aposRemover = db.chamadas.filter((c) => c.tabela === "crm_pipelines" && c.op === "update").at(-1)?.patch as {
      settings: { fields: unknown[] };
    };
    expect(aposRemover.settings.fields).toEqual([outro]);

    comoToken("manager", ["mcp:write"]);
    expect((await DELETE(req(`${base}/origem`, "DELETE"), ctxDe({ id: FUNIL, key: "origem" }))).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// agentes de IA
// ---------------------------------------------------------------------------

describe("agentes de IA por token", () => {
  const versaoDoBanco = {
    id: VERSAO,
    agent_id: AGENTE,
    organization_id: ORG_TOKEN,
    tool_ids: [],
    operator_tool_ids: [],
    status: "draft",
    provider: "anthropic",
    credential_id: CREDENCIAL,
  };

  it("GET /ai/agents: manager+mcp:read lê só os agentes da organização do token; agent → 403; sem credencial → 401", async () => {
    const db = bancoFalso({ ai_agents: () => [{ id: AGENTE, name: "Atendente" }] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const { GET } = await import("@/app/api/v1/ai/agents/route");
    comoToken("manager", ["mcp:read"]);
    const res = await GET(req("/api/v1/ai/agents", "GET"));
    expect(res.status).toBe(200);
    expect(db.chamadas[0]?.filtros.organization_id).toBe(ORG_TOKEN);

    comoToken("agent", ["mcp:read"]);
    expect((await GET(req("/api/v1/ai/agents", "GET"))).status).toBe(403);
    expect((await GET(req("/api/v1/ai/agents", "GET", undefined, {}, false))).status).toBe(401);
  });

  it("POST publish: manager → 403; token de agente de IA → 403; corpo com campo extra (organization_id) → 422", async () => {
    const { POST } = await import("@/app/api/v1/ai/agents/[id]/publish/route");
    const url = `/api/v1/ai/agents/${AGENTE}/publish`;
    comoToken("manager", ["mcp:write"]);
    expect((await POST(req(url, "POST", { version_id: VERSAO }), ctxDe({ id: AGENTE }))).status).toBe(403);
    comoToken("admin", ["mcp:write"], "ai_agent");
    expect((await POST(req(url, "POST", { version_id: VERSAO }), ctxDe({ id: AGENTE }))).status).toBe(403);

    vi.mocked(createAdminClient).mockReturnValue(bancoFalso({}) as never);
    comoToken("admin", ["mcp:write"]);
    expect((await POST(req(url, "POST", { version_id: VERSAO, organization_id: ORG_OUTRA }), ctxDe({ id: AGENTE }))).status).toBe(422);
  });

  it("POST publish: versão de OUTRA organização → 404 e a chave não vira; da própria → publica e o audit leva o token", async () => {
    const db = bancoFalso(
      {
        ai_agent_versions: (c) => (c.filtros.organization_id === ORG_TOKEN ? versaoDoBanco : null),
        event_log: () => null,
      },
      (nome, args) =>
        nome === "fn_publish_ai_agent_version"
          ? [{ agent_id: AGENTE, version_id: VERSAO, previous_version_id: null, published_at: "2026-10-17T12:00:00Z" }]
          : args,
    );
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    const { POST } = await import("@/app/api/v1/ai/agents/[id]/publish/route");
    const url = `/api/v1/ai/agents/${AGENTE}/publish`;
    comoToken("admin", ["mcp:write"]);

    // A versão existe, mas é de um agente diferente do da URL: 404.
    const outroAgente = "66666666-6666-4666-8666-666666666666";
    const errado = await POST(req(`/api/v1/ai/agents/${outroAgente}/publish`, "POST", { version_id: VERSAO }), ctxDe({ id: outroAgente }));
    expect(errado.status).toBe(404);
    expect(db.rpcs).toEqual([]);

    const res = await POST(req(url, "POST", { version_id: VERSAO }), ctxDe({ id: AGENTE }));
    expect(res.status).toBe(200);
    expect(db.rpcs[0]).toMatchObject({ nome: "fn_publish_ai_agent_version", args: { p_org_id: ORG_TOKEN, p_agent_id: AGENTE, p_version_id: VERSAO } });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_agent.published", organizationId: ORG_TOKEN, actorApiTokenId: TOKEN_ID, actorUserId: null }),
    );
  });

  it("POST publish: versão com capacidade inexistente no catálogo → 422 tool_id_invalid, sem virar a chave", async () => {
    const db = bancoFalso({ ai_agent_versions: () => ({ ...versaoDoBanco, tool_ids: ["capacidade_inventada"] }) });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/ai/agents/[id]/publish/route");
    const res = await POST(req(`/api/v1/ai/agents/${AGENTE}/publish`, "POST", { version_id: VERSAO }), ctxDe({ id: AGENTE }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("tool_id_invalid");
    expect(db.rpcs).toEqual([]);
  });

  it("POST pause: manager → 403; admin pausa o agente DA organização do token e audita o token; agente alheio → 404", async () => {
    const { POST } = await import("@/app/api/v1/ai/agents/[id]/pause/route");
    const url = `/api/v1/ai/agents/${AGENTE}/pause`;
    comoToken("manager", ["mcp:write"]);
    expect((await POST(req(url, "POST"), ctxDe({ id: AGENTE }))).status).toBe(403);

    const db = bancoFalso({
      ai_agents: (c) => (c.filtros.organization_id === ORG_TOKEN ? { id: AGENTE, published_version_id: VERSAO, archived_at: null } : null),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const res = await POST(req(url, "POST"), ctxDe({ id: AGENTE }));
    expect(res.status).toBe(200);
    const escrita = db.chamadas.find((c) => c.op === "update");
    expect(escrita?.filtros).toMatchObject({ id: AGENTE, organization_id: ORG_TOKEN });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_agent.paused", actorApiTokenId: TOKEN_ID }),
    );

    const vazio = bancoFalso({ ai_agents: () => null });
    vi.mocked(createAdminClient).mockReturnValue(vazio as never);
    expect((await POST(req(url, "POST"), ctxDe({ id: AGENTE }))).status).toBe(404);
    expect(vazio.chamadas.some((c) => c.op === "update")).toBe(false);
  });

  it("POST versions: valida pelo schema da tela (422) e grava rascunho com created_by = dono da chave", async () => {
    const db = bancoFalso({
      ai_agents: () => ({ id: AGENTE, kind: "mcp_agent", archived_at: null }),
      ai_agent_versions: (c) => (c.op === "insert" ? { id: VERSAO, version_number: 2 } : { version_number: 1 }),
      // A credencial escolhida é desta organização, ativa e do provedor da versão.
      ai_provider_credentials: () => ({ provider: "anthropic", is_active: true }),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/ai/agents/[id]/versions/route");
    const url = `/api/v1/ai/agents/${AGENTE}/versions`;

    const ruim = await POST(req(url, "POST", { system_prompt: "curto" }), ctxDe({ id: AGENTE }));
    expect(ruim.status).toBe(422);

    const corpo = {
      system_prompt: "Você atende clientes de uma clínica com cordialidade.",
      provider: "anthropic",
      model: "claude-sonnet-5",
      credential_id: CREDENCIAL,
      channel_session_id: null,
    };
    const res = await POST(req(url, "POST", corpo), ctxDe({ id: AGENTE }));
    expect(res.status).toBe(201);
    const insercao = db.chamadas.find((c) => c.tabela === "ai_agent_versions" && c.op === "insert");
    expect(insercao?.patch).toMatchObject({ organization_id: ORG_TOKEN, agent_id: AGENTE, status: "draft", created_by: DONO, version_number: 2 });
  });

  it("POST versions: na chave da instalação (credential_id null) só vale OpenRouter + modelo liberado; o resto é 422", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-da-instalacao");
    const db = bancoFalso({
      ai_agents: () => ({ id: AGENTE, kind: "mcp_agent", archived_at: null }),
      ai_agent_versions: (c) => (c.op === "insert" ? { id: VERSAO, version_number: 2 } : { version_number: 1 }),
    });
    vi.mocked(createAdminClient).mockReturnValue(db as never);
    comoToken("admin", ["mcp:write"]);
    const { POST } = await import("@/app/api/v1/ai/agents/[id]/versions/route");
    const url = `/api/v1/ai/agents/${AGENTE}/versions`;
    const base = {
      system_prompt: "Você atende clientes de uma clínica com cordialidade.",
      credential_id: null,
      channel_session_id: null,
    };

    const outroProvedor = await POST(
      req(url, "POST", { ...base, provider: "anthropic", model: "claude-sonnet-5" }),
      ctxDe({ id: AGENTE }),
    );
    expect(outroProvedor.status).toBe(422);
    expect(JSON.stringify(await outroProvedor.json())).toContain("provider_not_allowed");

    const emLote = await POST(
      req(url, "POST", { ...base, provider: "openrouter", model: "openai/gpt-6-luna:batch" }),
      ctxDe({ id: AGENTE }),
    );
    expect(emLote.status).toBe(422);
    expect(JSON.stringify(await emLote.json())).toContain("model_not_allowed");
    expect(db.chamadas.some((c) => c.tabela === "ai_agent_versions" && c.op === "insert")).toBe(false);
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// proxy: só o caminho exato é liberado para Bearer
// ---------------------------------------------------------------------------

describe("public-paths da fase 2", () => {
  const U = FUNIL;
  it.each([
    `/api/v1/webhook-sources/${U}/rotate-secret`,
    `/api/v1/pipelines/${U}/fields`,
    `/api/v1/pipelines/${U}/fields/origem`,
    "/api/v1/ai/agents",
    `/api/v1/ai/agents/${U}`,
    `/api/v1/ai/agents/${U}/versions`,
    `/api/v1/ai/agents/${U}/publish`,
    `/api/v1/ai/agents/${U}/pause`,
    `/api/v1/ai/agents/${U}/versions/${U}`,
  ])("libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    "/api/v1/ai/agents/assignable",
    `/api/v1/ai/agents/${U}/runs`,
    `/api/v1/ai/agents/${U}/versions/${U}/test`,
    `/api/v1/ai/agents/${U}/proposals/${U}/apply`,
    `/api/v1/pipelines/${U}/fields/origem/extra`,
    `/api/v1/pipelines/${U}/fields/1invalida`,
    "/api/v1/pipelines/nao-e-uuid/fields",
    `/api/v1/webhook-sources/${U}/rotate-secret/x`,
    "/api/v1/ai/agents/../credentials",
  ])("NÃO libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
