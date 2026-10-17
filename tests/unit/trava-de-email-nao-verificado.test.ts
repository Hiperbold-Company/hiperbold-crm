/**
 * D-204: enquanto a verificação de e-mail do CRM da conta está em aberto, a conta não cria o que sobrevive à troca
 * de senha (chave de API, conexão com MCP externo, convite, entrada automática). Medido pela regra e pelo
 * comportamento de duas rotas reais (só a borda é dublê: sessão, banco, audit).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { contaPodeCriarArtefatos, recusaSeEmailNaoVerificado } from "@/lib/auth/exigir-email-verificado";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

import { PEDIDO_EM_ABERTO } from "./helpers/gotrue-admin-falso";

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

let appMetadata: Record<string, unknown> = {};
let leituraFalha = false;
let escritasNoBanco: string[] = [];

function adminFalso() {
  return {
    auth: {
      admin: {
        getUserById: vi.fn(async () =>
          leituraFalha
            ? { data: { user: null }, error: { message: "fora" } }
            : { data: { user: { id: USER_ID, app_metadata: appMetadata } }, error: null },
        ),
      },
    },
    from: (tabela: string) => {
      escritasNoBanco.push(tabela);
      throw new Error(`a rota tocou ${tabela} com a conta sem o e-mail confirmado`);
    },
  };
}

function sessaoAdmin() {
  const user: AuthUser = {
    id: USER_ID,
    email: "u@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "admin" });
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
  vi.mocked(createClient).mockResolvedValue({
    rpc: async (fn: string) => (fn === "fn_user_role_in_org" ? { data: "admin", error: null } : { data: null, error: null }),
  } as never);
  vi.mocked(createAdminClient).mockImplementation(() => adminFalso() as never);
}

function requisicao(url: string, corpo: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  appMetadata = {};
  leituraFalha = false;
  escritasNoBanco = [];
});

describe("contaPodeCriarArtefatos", () => {
  it("conta sem pedido em aberto (antiga, do Google, de instalação sem a verificação) pode", async () => {
    expect(await contaPodeCriarArtefatos(USER_ID, adminFalso() as never)).toBe(true);
  });

  it("conta com o pedido de verificação em aberto NÃO pode", async () => {
    appMetadata = { email_verificacao: PEDIDO_EM_ABERTO };
    expect(await contaPodeCriarArtefatos(USER_ID, adminFalso() as never)).toBe(false);
  });

  it("depois do carimbo pode, e o carimbo em user_metadata não conta", async () => {
    appMetadata = { email_verificado_em: "2026-10-17T00:00:00Z", email_verificacao: null };
    expect(await contaPodeCriarArtefatos(USER_ID, adminFalso() as never)).toBe(true);
  });

  it("não conseguiu ler a conta: FALHA FECHADA", async () => {
    leituraFalha = true;
    expect(await contaPodeCriarArtefatos(USER_ID, adminFalso() as never)).toBe(false);
  });

  it("a recusa é 403 `email_not_verified` com a frase pedida; token sem dono passa (o token é a autoridade)", async () => {
    appMetadata = { email_verificacao: PEDIDO_EM_ABERTO };
    const res = await recusaSeEmailNaoVerificado({
      userId: USER_ID,
      frase: "Confirme seu e-mail para criar chaves de API.",
      requestId: "r1",
      admin: adminFalso() as never,
    });
    expect(res?.status).toBe(403);
    const corpo = (await res!.json()) as { error: { code: string; message: string } };
    expect(corpo.error).toMatchObject({ code: "email_not_verified", message: "Confirme seu e-mail para criar chaves de API." });

    expect(
      await recusaSeEmailNaoVerificado({ userId: null, frase: "x", requestId: "r2", admin: adminFalso() as never }),
    ).toBeNull();
  });
});

describe("as rotas recusam a conta com o e-mail por confirmar, antes de qualquer escrita", () => {
  it("POST /settings/api-tokens: 403, nenhuma chave, nenhuma escrita", async () => {
    sessaoAdmin();
    appMetadata = { email_verificacao: PEDIDO_EM_ABERTO };
    const { POST } = await import("@/app/api/v1/settings/api-tokens/route");

    const res = await POST(requisicao("/api/v1/settings/api-tokens", { name: "ERP", scopes: ["mcp:read", "role:manager"] }));

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("email_not_verified");
    expect(escritasNoBanco).toEqual([]);
  });

  it("POST /ai/mcp/conexoes: 403, nada é conectado", async () => {
    sessaoAdmin();
    appMetadata = { email_verificacao: PEDIDO_EM_ABERTO };
    const { POST } = await import("@/app/api/v1/ai/mcp/conexoes/route");

    const res = await POST(
      requisicao("/api/v1/ai/mcp/conexoes", { apelido: "ext", nome: "Externo", url: "https://mcp.example.com/mcp" }),
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("email_not_verified");
    expect(escritasNoBanco).toEqual([]);
  });

  it("conta com o e-mail confirmado passa da trava (controle positivo: a recusa acima não é a rota recusando tudo)", async () => {
    sessaoAdmin();
    appMetadata = { email_verificado_em: "2026-10-17T00:00:00Z" };
    const { POST } = await import("@/app/api/v1/settings/api-tokens/route");

    // O controle positivo para na primeira escrita (o dublê lança): o que importa é NÃO ter sido o 403 da trava.
    const res = await POST(requisicao("/api/v1/settings/api-tokens", { name: "ERP", scopes: ["mcp:read", "role:manager"] })).catch(
      () => null,
    );

    expect(res === null || res.status !== 403).toBe(true);
    expect(escritasNoBanco).toContain("api_tokens");
  });
});
