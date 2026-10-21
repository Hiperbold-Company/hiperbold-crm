/**
 * PERMISSÕES POR PERFIL — varredura das rotas guardadas.
 *
 * Para cada rota: no PADRÃO o papel de sempre passa do portão (nenhum
 * `forbidden_permission`, nenhum `authz.denied` por permissão, mesmo piso de
 * papel de antes); com a capacidade TIRADA daquele papel, 403
 * `forbidden_permission` SEM tocar no banco — nenhuma leitura, nenhuma escrita.
 *
 * "Tocar no banco" é medido por um cliente-sentinela: qualquer `.from`, `.rpc`,
 * `.storage`… conta. A rota que recusa antes do efeito deixa a conta em zero.
 *
 * Ao fim, dois casos que a varredura não cobre: o caminho de TOKEN Bearer de uma
 * rota dupla não é afetado pela escolha da organização, e o painel de perdas
 * liberado ao atendente responde 200 com o relatório.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import type * as McpAuth from "@/lib/mcp/auth";
import type { Role } from "@/lib/auth/types";
import { capacidade, type ChaveDePermissao } from "@/lib/permissoes/catalogo";
import { resolverPermissoes } from "@/lib/permissoes/resolver";

import { clienteEmMemoria, criarBanco } from "./helpers/supabase-em-memoria";

const auditSpy = vi.fn(async (_e: unknown) => undefined);
vi.mock("@/lib/audit", () => ({
  audit: (e: unknown) => auditSpy(e),
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () => null,
  supportWriteError: () => null,
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, window_start: 0 })),
  devolverRateLimit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof McpAuth>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

// ─── O cliente-sentinela ─────────────────────────────────────────────────────
let toques = 0;
function cadeia(): unknown {
  const fn = () => cadeia();
  return new Proxy(fn, {
    get(_alvo, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: { code: "XX000", message: "sentinela" }, count: null });
      }
      return cadeia();
    },
    apply() {
      return cadeia();
    },
  });
}
function sentinela(): unknown {
  return new Proxy(
    {},
    {
      get(_alvo, prop) {
        // `await createClient()` consulta `.then` do resultado: isso não é tocar no banco.
        if (prop === "then") return undefined;
        toques += 1;
        return cadeia();
      },
    },
  );
}
let clienteAdmin: () => unknown = sentinela;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sentinela() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteAdmin() }));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "99999999-9999-4999-8999-999999999999";
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

function sessao(role: Role, permissoes?: Record<string, string[]>) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER,
      email: "x@exemplo.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR",
      organizations: [],
    },
    org: {
      orgId: ORG,
      name: "Org",
      role,
      ...(permissoes ? { permissoes: resolverPermissoes(permissoes) } : {}),
    },
  });
}

function req(
  metodo: string,
  url: string,
  corpo?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: metodo,
    headers: { "content-type": "application/json", ...headers },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
}
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

async function codigo(res: Response): Promise<string | undefined> {
  const corpo = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: string } } | null;
  return corpo?.error?.code;
}

const negadoPorPermissao = () =>
  auditSpy.mock.calls.some(
    ([e]) =>
      (e as { action?: string; metadata?: { reason?: string } }).metadata?.reason === "permission",
  );

interface Caso {
  nome: string;
  chave: ChaveDePermissao;
  /** O papel que tem a capacidade no padrão e é o testado. */
  papel: Role;
  /** Piso que o `requireRole` recebe — o de antes desta feature. */
  piso: Role;
  chamar: () => Promise<Response>;
}

const CASOS: Caso[] = [
  {
    nome: "POST /leads/[id]/win",
    chave: "negocios.mover",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/leads/[id]/win/route")).POST(
        req("POST", `/api/v1/leads/${ID}/win`, {}),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "POST /leads/[id]/lose",
    chave: "negocios.mover",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/leads/[id]/lose/route")).POST(
        req("POST", `/api/v1/leads/${ID}/lose`, { lost_reason: "preco" }),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "POST /leads/bulk (move)",
    chave: "negocios.mover",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/leads/bulk/route")).POST(
        req("POST", "/api/v1/leads/bulk", {
          action: "move",
          lead_ids: [ID],
          params: { stage_id: ID2 },
        }),
      ),
  },
  {
    nome: "POST /leads/[id]/activities",
    chave: "negocios.registrar",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/leads/[id]/activities/route")).POST(
        req("POST", `/api/v1/leads/${ID}/activities`, { subtype: "nota", text: "x" }),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "POST /leads/[id]/itens",
    chave: "negocios.registrar",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/leads/[id]/itens/route")).POST(
        req("POST", `/api/v1/leads/${ID}/itens`, {
          nome: "Item",
          quantidade: 1,
          preco_unitario_cents: 100,
        }),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "PATCH /leads/[id]/itens/[itemId]",
    chave: "negocios.registrar",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/leads/[id]/itens/[itemId]/route")).PATCH(
        req("PATCH", `/api/v1/leads/${ID}/itens/${ID2}`, { quantidade: 2 }),
        ctx({ id: ID, itemId: ID2 }),
      ),
  },
  {
    nome: "DELETE /leads/[id]/itens/[itemId]",
    chave: "negocios.registrar",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/leads/[id]/itens/[itemId]/route")).DELETE(
        req("DELETE", `/api/v1/leads/${ID}/itens/${ID2}`),
        ctx({ id: ID, itemId: ID2 }),
      ),
  },
  {
    nome: "POST /leads/import",
    chave: "contatos.importar",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/leads/import/route")).POST(
        req("POST", "/api/v1/leads/import", { linhas: [] }),
      ),
  },
  {
    nome: "POST /messages",
    chave: "chat.responder",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/messages/route")).POST(
        req("POST", "/api/v1/messages", { conversation_id: ID, text: "oi" }),
      ),
  },
  {
    nome: "PATCH /messages/[id]",
    chave: "chat.responder",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/messages/[id]/route")).PATCH(
        req("PATCH", `/api/v1/messages/${ID}`, { text: "editado" }),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "DELETE /messages/[id]",
    chave: "chat.responder",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/messages/[id]/route")).DELETE(
        req("DELETE", `/api/v1/messages/${ID}`),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "POST /conversations/[id]/media",
    chave: "chat.responder",
    papel: "agent",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/conversations/[id]/media/route")).POST(
        req("POST", `/api/v1/conversations/${ID}/media`, {}),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "GET /metrics/lost",
    chave: "relatorios.perdas",
    papel: "manager",
    piso: "agent",
    chamar: async () =>
      (await import("@/app/api/v1/metrics/lost/route")).GET(req("GET", "/api/v1/metrics/lost")),
  },
  {
    nome: "GET /ads/meta/campaigns",
    chave: "relatorios.anuncios",
    papel: "manager",
    piso: "manager",
    chamar: async () =>
      (await import("@/app/api/v1/ads/meta/campaigns/route")).GET(
        req("GET", "/api/v1/ads/meta/campaigns?account_id=act_1"),
      ),
  },
  {
    nome: "POST /automation-rules",
    chave: "automacoes.gerenciar",
    papel: "manager",
    piso: "manager",
    chamar: async () =>
      (await import("@/app/api/v1/automation-rules/route")).POST(
        req("POST", "/api/v1/automation-rules", { name: "Regra" }),
      ),
  },
  {
    nome: "PATCH /automation-rules/[id]",
    chave: "automacoes.gerenciar",
    papel: "manager",
    piso: "manager",
    chamar: async () =>
      (await import("@/app/api/v1/automation-rules/[id]/route")).PATCH(
        req("PATCH", `/api/v1/automation-rules/${ID}`, { name: "Regra" }),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "DELETE /automation-rules/[id]",
    chave: "automacoes.gerenciar",
    papel: "manager",
    piso: "manager",
    chamar: async () =>
      (await import("@/app/api/v1/automation-rules/[id]/route")).DELETE(
        req("DELETE", `/api/v1/automation-rules/${ID}`),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "POST /webhook-sources",
    chave: "automacoes.gerenciar",
    papel: "manager",
    piso: "manager",
    chamar: async () =>
      (await import("@/app/api/v1/webhook-sources/route")).POST(
        req("POST", "/api/v1/webhook-sources", { name: "Site" }),
      ),
  },
  {
    nome: "PATCH /webhook-sources/[id]",
    chave: "automacoes.gerenciar",
    papel: "manager",
    piso: "manager",
    chamar: async () =>
      (await import("@/app/api/v1/webhook-sources/[id]/route")).PATCH(
        req("PATCH", `/api/v1/webhook-sources/${ID}`, { name: "Site" }),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "DELETE /webhook-sources/[id]",
    chave: "automacoes.gerenciar",
    papel: "manager",
    piso: "manager",
    chamar: async () =>
      (await import("@/app/api/v1/webhook-sources/[id]/route")).DELETE(
        req("DELETE", `/api/v1/webhook-sources/${ID}`),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "POST /webhook-sources/[id]/rotate-secret",
    chave: "automacoes.gerenciar",
    papel: "manager",
    piso: "manager",
    chamar: async () =>
      (await import("@/app/api/v1/webhook-sources/[id]/rotate-secret/route")).POST(
        req("POST", `/api/v1/webhook-sources/${ID}/rotate-secret`, {}),
        ctx({ id: ID }),
      ),
  },
  {
    nome: "PUT /pipelines/[id]/agent-mapping",
    chave: "funis.editar",
    papel: "manager",
    piso: "manager",
    chamar: async () =>
      (await import("@/app/api/v1/pipelines/[id]/agent-mapping/route")).PUT(
        req("PUT", `/api/v1/pipelines/${ID}/agent-mapping`, { mappings: [] }),
        ctx({ id: ID }),
      ),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  toques = 0;
  clienteAdmin = sentinela;
});

describe.each(CASOS)("$nome ($chave)", ({ chave, papel, piso, chamar }) => {
  it(`padrão: ${papel} passa do portão, com o mesmo piso de antes`, async () => {
    sessao(papel);
    const res = await chamar();
    expect(await codigo(res)).not.toBe("forbidden_permission");
    expect(negadoPorPermissao()).toBe(false);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe(piso);
  });

  it(`tirar de ${papel} → 403 forbidden_permission, sem tocar no banco`, async () => {
    const semOPapel = capacidade(chave).padrao.filter((p) => p !== papel);
    sessao(papel, { [chave]: [...semOPapel] });
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(await codigo(res)).toBe("forbidden_permission");
    expect(negadoPorPermissao()).toBe(true);
    expect(toques).toBe(0);
  });
});

describe("POST /leads/bulk — só o move obedece a negocios.mover", () => {
  it("assign com negocios.mover tirado do gerente NÃO vira forbidden_permission (segue o requireRole de antes)", async () => {
    sessao("manager", { "negocios.mover": [] });
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(
      req("POST", "/api/v1/leads/bulk", {
        action: "assign",
        lead_ids: [ID],
        params: { owner_user_id: null },
      }),
    );
    expect(await codigo(res)).not.toBe("forbidden_permission");
  });
});

describe("POST /leads/[id]/move — padrão afirma o desfecho, não só a ausência de 403", () => {
  it("atendente no padrão chega à validação do corpo (422 validation_error)", async () => {
    sessao("agent");
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");
    const res = await POST(req("POST", `/api/v1/leads/${ID}/move`, {}), ctx({ id: ID }));
    expect(res.status).toBe(422);
    expect(await codigo(res)).toBe("validation_error");
  });
});

describe("caminho de TOKEN Bearer não é afetado pela escolha da organização", () => {
  it("resolveAuthDual com Bearer e `negocios.mover` tirado de todos: passa pelo token, sem consultar a sessão", async () => {
    const { validateBearerToken } = await import("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG,
      scopes: ["mcp:read", "mcp:write"],
      role: "agent",
      actor: { type: "api_token", id: "tok-1" },
    } as never);
    // A sessão (se fosse consultada) seria recusada pela permissão.
    sessao("agent", { "negocios.mover": [] });
    const { resolveAuthDual } = await import("@/lib/api/auth-dual");
    const r = await resolveAuthDual(
      req("POST", `/api/v1/leads/${ID}/move`, {}, { authorization: "Bearer dsk_abc" }),
      {
        requestId: "r1",
        resource: "crm_leads",
        role: "agent",
        scope: "mcp:write",
        permissao: "negocios.mover",
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe("token");
    expect(vi.mocked(requireRole)).not.toHaveBeenCalled();
    expect(negadoPorPermissao()).toBe(false);
  });

  it("e a mesma chamada pela SESSÃO é recusada — o controle da prova acima", async () => {
    sessao("agent", { "negocios.mover": [] });
    const { resolveAuthDual } = await import("@/lib/api/auth-dual");
    const r = await resolveAuthDual(req("POST", `/api/v1/leads/${ID}/move`, {}), {
      requestId: "r1",
      resource: "crm_leads",
      role: "agent",
      scope: "mcp:write",
      permissao: "negocios.mover",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await codigo(r.response)).toBe("forbidden_permission");
  });

  it("rota que declara `role` acima do piso da permissão explode fora de produção", async () => {
    const { resolveAuthDual } = await import("@/lib/api/auth-dual");
    await expect(
      resolveAuthDual(req("POST", "/x", {}), {
        requestId: "r1",
        resource: "x",
        role: "manager",
        scope: "mcp:write",
        permissao: "negocios.mover",
      }),
    ).rejects.toThrow(/acima do piso/);
  });
});

describe("GET /metrics/lost liberado para o atendente", () => {
  it("atendente com relatorios.perdas liberado → 200 com o relatório da organização", async () => {
    const banco = criarBanco({
      crm_leads: [
        {
          id: "l1",
          organization_id: ORG,
          status: "lost",
          lost_reason: "preco",
          lost_from_stage_id: "e1",
          value_cents: 1000,
          currency: "BRL",
          pipeline_id: "f1",
          closed_at: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
      crm_pipelines: [{ id: "f1", organization_id: ORG, settings: {} }],
      crm_stages: [{ id: "e1", organization_id: ORG, name: "Proposta" }],
    });
    clienteAdmin = () => clienteEmMemoria(banco);
    sessao("agent", { "relatorios.perdas": ["manager", "agent"] });
    const { GET } = await import("@/app/api/v1/metrics/lost/route");
    const res = await GET(req("GET", "/api/v1/metrics/lost"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as {
      data: { porMoeda: Array<{ moeda: string; quantidade: number }> };
    };
    expect(corpo.data.porMoeda).toEqual([expect.objectContaining({ moeda: "BRL", quantidade: 1 })]);
  });

  it("no padrão o atendente leva 403 forbidden_permission", async () => {
    sessao("agent");
    const { GET } = await import("@/app/api/v1/metrics/lost/route");
    const res = await GET(req("GET", "/api/v1/metrics/lost"));
    expect(res.status).toBe(403);
    expect(await codigo(res)).toBe("forbidden_permission");
  });
});
