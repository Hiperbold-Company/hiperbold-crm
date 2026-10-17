/**
 * 0962 (auditoria de 17/10/2026): `api_tokens` só é escrita pelo servidor.
 *
 * As rotas de emissão, listagem e revogação de chave passam a gravar pelo cliente
 * de serviço, DEPOIS do gate real (`requireRole("admin")`, com a prova do segundo
 * fator). O que se mede, pelo comportamento da rota (só a borda é dublê: sessão,
 * banco, audit):
 *
 *  - a emissão grava pelo cliente de serviço com a organização da SESSÃO e
 *    `created_by` = quem está na sessão; o cliente da sessão nunca toca a tabela e
 *    uma `organization_id` no corpo é ignorada;
 *  - o teto de papel: ninguém emite chave com `role:` acima do papel que tem;
 *  - sessão aal1 de quem tem fator (`mfa_required`) não emite, não lista, não revoga,
 *    e nada chega ao banco;
 *  - a revogação filtra pela organização da sessão (token de outra organização é 404);
 *  - o teto de tokens ativos (PT409) continua virando 409.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { papelAcimaDoCriador } from "@/lib/auth/teto-de-papel-da-chave";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
  sessionAal: vi.fn(async () => "aal1"),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ORG_OUTRA = "44444444-4444-4444-8444-444444444444";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";

interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update";
  filtros: Record<string, unknown>;
  patch?: Record<string, unknown>;
}

let chamadasDoServidor: Chamada[] = [];
let tabelasDaSessao: string[] = [];
let linhaDoToken: { id: string; revoked_at: string | null } | null = null;
let erroDoInsert: { code?: string; message: string } | null = null;

function bancoDeServico() {
  return {
    from: (tabela: string) => {
      const c: Chamada = { tabela, op: "select", filtros: {} };
      const resolver = () => {
        chamadasDoServidor.push({ ...c, filtros: { ...c.filtros } });
        if (c.op === "insert") {
          if (erroDoInsert) return { data: null, error: erroDoInsert };
          return { data: { id: TOKEN_ID, ...(c.patch ?? {}) }, error: null };
        }
        if (c.op === "update") return { data: null, error: null };
        // select
        if (c.filtros.id !== undefined) {
          const dono = c.filtros.organization_id === ORG_ID;
          return { data: dono ? linhaDoToken : null, error: null };
        }
        return { data: [], error: null };
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        insert: (p: Record<string, unknown>) => ((c.op = "insert"), (c.patch = p), chain),
        update: (p: Record<string, unknown>) => ((c.op = "update"), (c.patch = p), chain),
        eq: (col: string, v: unknown) => ((c.filtros[col] = v), chain),
        order: () => chain,
        maybeSingle: async () => resolver(),
        single: async () => resolver(),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve(resolver()).then(ok, ko),
      };
      return chain;
    },
  };
}

function sessao(papel: Role, { mfaEmDivida: emDivida = false }: { mfaEmDivida?: boolean } = {}) {
  const user: AuthUser = {
    id: USER_ID,
    email: "u@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: papel }],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: papel });
  vi.mocked(mfaEmDivida).mockResolvedValue(emDivida);
  vi.mocked(createClient).mockResolvedValue({
    rpc: async (fn: string) => (fn === "fn_user_role_in_org" ? { data: papel, error: null } : { data: null, error: null }),
    from: (tabela: string) => {
      tabelasDaSessao.push(tabela);
      throw new Error(`o cliente da sessão tocou ${tabela}: a escrita é do servidor (0962)`);
    },
  } as never);
  vi.mocked(createAdminClient).mockImplementation(() => bancoDeServico() as never);
}

function post(corpo: unknown) {
  return new NextRequest("http://localhost/api/v1/settings/api-tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}
const get = () => new NextRequest("http://localhost/api/v1/settings/api-tokens");
const ctx = { params: Promise.resolve({ id: TOKEN_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  chamadasDoServidor = [];
  tabelasDaSessao = [];
  linhaDoToken = { id: TOKEN_ID, revoked_at: null };
  erroDoInsert = null;
});

describe("POST /settings/api-tokens: emissão pelo servidor", () => {
  it("grava pelo cliente de serviço, com a organização e o autor da SESSÃO", async () => {
    sessao("admin");
    const { POST } = await import("@/app/api/v1/settings/api-tokens/route");

    const res = await POST(
      post({ name: "Integração ERP", scopes: ["mcp:read", "role:manager"], organization_id: ORG_OUTRA, created_by: "x" }),
    );

    expect(res.status).toBe(201);
    const insercao = chamadasDoServidor.find((c) => c.tabela === "api_tokens" && c.op === "insert");
    expect(insercao, "a emissão não passou pelo cliente de serviço").toBeDefined();
    expect(insercao?.patch?.organization_id, "a organização veio do corpo").toBe(ORG_ID);
    expect(insercao?.patch?.created_by).toBe(USER_ID);
    expect(insercao?.patch?.scopes).toEqual(["mcp:read", "role:manager"]);
    expect(tabelasDaSessao, "o cliente da sessão tocou o banco").toEqual([]);

    const corpo = (await res.json()) as { data: { plaintext: string } };
    expect(corpo.data.plaintext.startsWith("dsk_")).toBe(true);
    // O banco recebe o hash, nunca o segredo.
    expect(JSON.stringify(insercao?.patch)).not.toContain(corpo.data.plaintext);
  });

  it("⭐ teto de papel: nenhuma chave nasce com `role:` acima do papel de quem a cria", () => {
    // O piso da rota é `admin`, então por ela o teto nunca morde hoje; é a defesa
    // para o dia em que o piso baixar, e é medida direto na regra.
    expect(papelAcimaDoCriador(["mcp:write", "role:admin"], "manager")).toBe("admin");
    expect(papelAcimaDoCriador(["mcp:write", "role:manager"], "manager")).toBeNull();
    expect(papelAcimaDoCriador(["mcp:write"], "manager")).toBeNull();
    // Dois `role:` na lista: o autenticador lê o primeiro, mas o teto olha TODOS.
    expect(papelAcimaDoCriador(["mcp:write", "role:viewer", "role:admin"], "manager")).toBe("admin");
    // Sem `role:` a chave vale como agent: quem não chega a agent não emite.
    expect(papelAcimaDoCriador(["mcp:write"], "viewer")).toBe("agent");
    // Papel que não existe na régua falha fechado.
    expect(papelAcimaDoCriador(["role:superuser"], "admin")).toBe("superuser");
  });

  it("admin emite `role:admin` (controle positivo do teto)", async () => {
    sessao("admin");
    const { POST } = await import("@/app/api/v1/settings/api-tokens/route");
    const res = await POST(post({ name: "Chave de admin", scopes: ["mcp:write", "role:admin"] }));
    expect(res.status).toBe(201);
  });

  it("escopo fora da lista fechada (autoria de agente) é 4xx e nada chega ao banco", async () => {
    sessao("admin");
    const { POST } = await import("@/app/api/v1/settings/api-tokens/route");
    const res = await POST(post({ name: "Forjada", scopes: ["mcp:read", "actor:ai_agent"] }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(chamadasDoServidor).toEqual([]);
  });

  it("⭐ sessão aal1 de quem tem fator: 403 mfa_required e o banco não é tocado", async () => {
    sessao("admin", { mfaEmDivida: true });
    const { POST } = await import("@/app/api/v1/settings/api-tokens/route");

    const res = await POST(post({ name: "Sem segundo fator", scopes: ["mcp:write", "role:admin"] }));

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    expect(chamadasDoServidor, "a sessão sem o fator chegou a escrever").toEqual([]);
    expect(tabelasDaSessao).toEqual([]);
  });

  it("gerente não emite (piso admin)", async () => {
    sessao("manager");
    const { POST } = await import("@/app/api/v1/settings/api-tokens/route");
    const res = await POST(post({ name: "Chave", scopes: ["mcp:read"] }));
    expect(res.status).toBe(403);
    expect(chamadasDoServidor).toEqual([]);
  });

  it("o teto de tokens ativos do banco (PT409) segue virando 409", async () => {
    sessao("admin");
    erroDoInsert = { code: "PT409", message: "Teto de tokens ativos por organização atingido: 50 de 50." };
    const { POST } = await import("@/app/api/v1/settings/api-tokens/route");
    const res = await POST(post({ name: "Mais uma", scopes: ["mcp:read"] }));
    expect(res.status).toBe(409);
  });
});

describe("GET /settings/api-tokens: listagem pelo servidor", () => {
  it("lê pelo cliente de serviço filtrando a organização da sessão", async () => {
    sessao("admin");
    const { GET } = await import("@/app/api/v1/settings/api-tokens/route");

    const res = await GET(get());

    expect(res.status).toBe(200);
    const leitura = chamadasDoServidor.find((c) => c.tabela === "api_tokens");
    expect(leitura?.filtros.organization_id).toBe(ORG_ID);
    expect(tabelasDaSessao).toEqual([]);
  });

  it("sessão aal1 de quem tem fator: 403 e nada é lido", async () => {
    sessao("admin", { mfaEmDivida: true });
    const { GET } = await import("@/app/api/v1/settings/api-tokens/route");
    const res = await GET(get());
    expect(res.status).toBe(403);
    expect(chamadasDoServidor).toEqual([]);
  });
});

describe("POST /settings/api-tokens/[id]/revoke: revogação pelo servidor", () => {
  it("revoga pelo cliente de serviço, com a organização da sessão no filtro do update", async () => {
    sessao("admin");
    const { POST } = await import("@/app/api/v1/settings/api-tokens/[id]/revoke/route");

    const res = await POST(post({}), ctx);

    expect(res.status).toBe(200);
    const update = chamadasDoServidor.find((c) => c.op === "update");
    expect(update?.filtros).toMatchObject({ id: TOKEN_ID, organization_id: ORG_ID });
    expect(update?.patch?.revoked_by).toBe(USER_ID);
    expect(tabelasDaSessao).toEqual([]);
  });

  it("token de outra organização é 404 e nenhum update acontece", async () => {
    sessao("admin");
    vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_OUTRA, name: "Outra", role: "admin" });
    const { POST } = await import("@/app/api/v1/settings/api-tokens/[id]/revoke/route");

    const res = await POST(post({}), ctx);

    expect(res.status).toBe(404);
    expect(chamadasDoServidor.some((c) => c.op === "update")).toBe(false);
  });

  it("sessão aal1 de quem tem fator: 403 e nada é revogado", async () => {
    sessao("admin", { mfaEmDivida: true });
    const { POST } = await import("@/app/api/v1/settings/api-tokens/[id]/revoke/route");
    const res = await POST(post({}), ctx);
    expect(res.status).toBe(403);
    expect(chamadasDoServidor).toEqual([]);
  });
});
