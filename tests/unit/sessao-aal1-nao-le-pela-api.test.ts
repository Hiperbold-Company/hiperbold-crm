/**
 * D-092, 3a parte (migration 1006): a sessão só com senha (aal1) de quem TEM fator também não LÊ o dado
 * da empresa pela API.
 *
 * O banco ganhou a trava `sessao_com_prova_de_mfa` (provada em
 * `tests/invariants/sessao-aal1-nao-le-dado-da-empresa.test.ts`), mas as rotas que leem com o cliente de
 * serviço ignoram a RLS. O ponto central delas é `orgAtivaDaApi` (as que não passam por `requireRole`) e,
 * no `requireRole`, o atalho `allowPlatformAdmin: "leitura"`, que devolvia o dado sem perguntar a sessão.
 *
 * Como em `require-role-mfa.test.ts`, `mfaEmDivida`, `mfaEmDividaEstrita`, `sessionAal` e
 * `isMfaEnrolled` são os REAIS, sobre um cliente Supabase stub (o GoTrue e o rpc do banco); só a
 * resolução do usuário e da org ativa é fixada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import type { AuthUser, Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, loadAuthUser: vi.fn(), orgAtivaSemPortao: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/poder-de-plataforma", () => ({ agindoPeloPoderDePlataforma: vi.fn(async () => false) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const USER_ID = "10060001-1111-4111-8111-111111111111";
const ORG_ID = "10060001-2222-4222-8222-222222222222";

interface Cenario {
  role: Role;
  temFator: boolean;
  aal: "aal1" | "aal2";
  isPlatformAdmin?: boolean;
  confiavel?: boolean;
}

function preparar({ role, temFator, aal, isPlatformAdmin = false, confiavel = false }: Cenario): AuthUser {
  const user = {
    id: USER_ID,
    email: "pessoa@teste.local",
    idioma: "pt-BR",
    is_platform_admin: isPlatformAdmin,
    platform_admin_scope: isPlatformAdmin ? "full" : null,
    organizations: [],
  } as unknown as AuthUser;
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG_ID, name: "Org", role, org_status: "active" });
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async (nome: string) =>
      nome === "fn_session_mfa_proven" ? { data: confiavel, error: null } : { data: role, error: null },
    ),
    auth: {
      getUser: vi.fn(async () => ({
        data: {
          user: { id: USER_ID, factors: temFator ? [{ id: "f1", factor_type: "totp", status: "verified" }] : [] },
        },
        error: null,
      })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: aal, nextLevel: temFator ? "aal2" : aal },
          error: null,
        })),
      },
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
  return user;
}

async function codigoDoErro(r: { ok: boolean; response?: Response }): Promise<string | null> {
  if (r.ok || !r.response) return null;
  return ((await r.response.json()) as { error: { code: string } }).error.code;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("orgAtivaDaApi — a org ativa das rotas sem requireRole pede a prova da sessão", () => {
  it("⭐ quem tem fator e está em aal1 leva 403 mfa_required, sem a org", async () => {
    const user = preparar({ role: "agent", temFator: true, aal: "aal1" });
    const r = await orgAtivaDaApi(user, "req-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
    expect(await codigoDoErro(r)).toBe("mfa_required");
  });

  it("CONTROLE POSITIVO: a mesma pessoa em aal2 recebe a org", async () => {
    const user = preparar({ role: "agent", temFator: true, aal: "aal2" });
    const r = await orgAtivaDaApi(user, "req-2");
    expect(r).toEqual({ ok: true, org: expect.objectContaining({ orgId: ORG_ID }) });
  });

  it("quem não tem fator, em aal1, recebe a org (a verificação é opcional)", async () => {
    const user = preparar({ role: "viewer", temFator: false, aal: "aal1" });
    const r = await orgAtivaDaApi(user);
    expect(r.ok).toBe(true);
  });

  it("aal1 reconhecida por dispositivo confiável recebe a org (mesma régua do banco)", async () => {
    const user = preparar({ role: "admin", temFator: true, aal: "aal1", confiavel: true });
    expect((await orgAtivaDaApi(user)).ok).toBe(true);
  });

  it("sem usuário, nada a provar: segue { ok: true, org: null }", async () => {
    expect(await orgAtivaDaApi(null)).toEqual({ ok: true, org: null });
  });
});

describe("requireRole com allowPlatformAdmin 'leitura' — o atalho também pede a prova", () => {
  it("⭐ platform admin com fator em aal1 leva 403 mfa_required", async () => {
    preparar({ role: "admin", temFator: true, aal: "aal1", isPlatformAdmin: true });
    const r = await requireRole("viewer", { allowPlatformAdmin: "leitura", requestId: "req-3" });
    expect(await codigoDoErro(r)).toBe("mfa_required");
  });

  it("CONTROLE POSITIVO: o mesmo platform admin em aal2 lê", async () => {
    preparar({ role: "admin", temFator: true, aal: "aal2", isPlatformAdmin: true });
    expect((await requireRole("viewer", { allowPlatformAdmin: "leitura" })).ok).toBe(true);
  });

  it("platform admin sem fator, em aal1, lê como antes", async () => {
    preparar({ role: "viewer", temFator: false, aal: "aal1", isPlatformAdmin: true });
    expect((await requireRole("admin", { allowPlatformAdmin: "leitura" })).ok).toBe(true);
  });

  it("pelo poder de plataforma (não é admin da org) o dispositivo confiável não basta", async () => {
    preparar({ role: "viewer", temFator: true, aal: "aal1", isPlatformAdmin: true, confiavel: true });
    const r = await requireRole("admin", { allowPlatformAdmin: "leitura" });
    expect(await codigoDoErro(r)).toBe("mfa_required");
  });
});
