/**
 * Auditoria de 17/10/2026, achado baixo 5: `validateBearerToken` respondia uma
 * mensagem DIFERENTE para cada motivo de recusa ("Token not recognized.", "Token
 * revoked.", "Token expired.", "Token creator no longer has access.",
 * "Organization suspended." com 403), e quem segura um `dsk_` roubado ou chutado
 * sondava o estado da chave e da empresa.
 *
 * Agora desconhecido, revogado, expirado, criador sem acesso e organização suspensa
 * devolvem a MESMA resposta (código MCP, status HTTP e mensagem); o motivo real fica
 * no log. Falha de infraestrutura segue 500 (não é token inválido) e formato torto
 * segue com a mensagem própria (não revela nada sobre token existente).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { McpAuthError, TOKEN_INVALIDO_MSG, validateBearerToken } from "@/lib/mcp/auth";

const ORG = "bbbbbbbb-2222-4222-8222-222222222222";
const CRIADOR = "cccccccc-3333-4333-8333-333333333333";
const PLAINTEXT = "dsk_abcd_segredoquenaopodevazar";

interface Cenario {
  token: null | {
    revoked_at?: string | null;
    expires_at?: string | null;
    org_status?: string;
    scopes?: string[];
  };
  /** Papel do criador na organização; `null` = sem vínculo ativo. */
  vinculo?: string | null;
  erroDoToken?: string;
}

function armar({ token, vinculo = "admin", erroDoToken }: Cenario) {
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) c[m] = () => c;
      c.update = () => ({ eq: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }) });
      c.maybeSingle = async () => {
        if (tabela === "api_tokens") {
          if (erroDoToken) return { data: null, error: { message: erroDoToken } };
          if (!token) return { data: null, error: null };
          return {
            data: {
              id: "tok-1",
              organization_id: ORG,
              scopes: token.scopes ?? ["mcp:read", "role:admin"],
              revoked_at: token.revoked_at ?? null,
              expires_at: token.expires_at ?? null,
              created_by: CRIADOR,
              organizations: { status: token.org_status ?? "active" },
            },
            error: null,
          };
        }
        if (tabela === "user_organizations") {
          return { data: vinculo ? { role: vinculo } : null, error: null };
        }
        throw new Error(`tabela inesperada: ${tabela}`);
      };
      return c;
    },
  } as never);
}

async function recusa() {
  try {
    await validateBearerToken(`Bearer ${PLAINTEXT}`);
  } catch (err) {
    if (err instanceof McpAuthError) {
      return { mcpCode: err.mcpCode, httpStatus: err.httpStatus, message: err.message };
    }
    throw err;
  }
  throw new Error("o token foi aceito onde a recusa era esperada");
}

beforeEach(() => vi.clearAllMocks());

const CASOS: Array<[string, Cenario, string]> = [
  ["desconhecido", { token: null }, "not_found"],
  ["revogado", { token: { revoked_at: "2026-09-01T10:00:00.000Z" } }, "revoked"],
  ["expirado", { token: { expires_at: "2020-01-01T00:00:00.000Z" } }, "expired"],
  ["criador sem vínculo ativo", { token: {}, vinculo: null }, "creator_inactive"],
  ["criador rebaixado abaixo do papel da chave", { token: {}, vinculo: "agent" }, "creator_inactive"],
  ["organização suspensa", { token: { org_status: "suspended" } }, "tenant_suspended"],
];

describe("recusa neutra de bearer", () => {
  it("CONTROLE POSITIVO: o mesmo token, em dia, é aceito (senão as recusas abaixo seriam vacuidade)", async () => {
    armar({ token: {} });
    await expect(validateBearerToken(`Bearer ${PLAINTEXT}`)).resolves.toMatchObject({ organizationId: ORG });
  });

  for (const [nome, cenario, motivo] of CASOS) {
    it(`${nome}: 401 com a mensagem única, e o motivo (${motivo}) só no log`, async () => {
      armar(cenario);

      const r = await recusa();

      expect(r).toEqual({ mcpCode: -32001, httpStatus: 401, message: TOKEN_INVALIDO_MSG });
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { reason: motivo });
      // Nada do motivo nem do plaintext vaza para a mensagem.
      expect(r.message).not.toMatch(/revoked|expired and|suspended|creator|recognized/i);
      expect(r.message).not.toContain(PLAINTEXT);
    });
  }

  it("as seis recusas são idênticas entre si (nenhuma distingue o motivo)", async () => {
    const respostas = new Set<string>();
    for (const [, cenario] of CASOS) {
      armar(cenario);
      respostas.add(JSON.stringify(await recusa()));
    }
    expect(respostas.size).toBe(1);
  });

  it("falha de infraestrutura segue 500: não é token inválido", async () => {
    armar({ token: null, erroDoToken: "connection reset" });
    const r = await recusa();
    expect(r.httpStatus).toBe(500);
    expect(r.mcpCode).toBe(-32603);
  });

  it("formato torto segue com a mensagem própria, que não diz nada sobre token existente", async () => {
    armar({ token: {} });
    const erro = await validateBearerToken("Bearer chave_de_outro_produto").catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(McpAuthError);
    expect((erro as McpAuthError).httpStatus).toBe(401);
    expect((erro as McpAuthError).message).toBe("Invalid token format.");
  });
});
