/**
 * D-092: o guarda de /admin exige a prova do segundo fator de quem TEM fator, mesmo quando
 * `platform_admins.mfa_required` está desligado. Antes só `mfa_required` mandava: o admin de
 * plataforma que cadastrou o TOTP por vontade própria e teve a coluna desmarcada entrava no /admin
 * com a sessão aal1 (só senha).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = {
  mfaRequired: false,
  nivel: "aal1" as string,
  fatores: [{ status: "verified" }] as Array<{ status: string }>,
  erroNosFatores: false,
  ultimoRedirect: null as string | null,
};

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    estado.ultimoRedirect = destino;
    throw new Error(`REDIRECT:${destino}`);
  },
}));
// O desafio leva de volta à página do painel pelo `x-pathname`; sem ele, `/admin`.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      // Os fatores vêm do próprio `getUser()` (validado no GoTrue), sem leitura a mais
      // (upstream). Sessão ilegível = sem usuário.
      getUser: async () =>
        estado.erroNosFatores
          ? { data: { user: null }, error: new Error("rede") }
          : {
              data: {
                user: { id: "u1", factors: estado.fatores.map((f) => ({ factor_type: "totp", ...f })) },
              },
            },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: estado.nivel } }),
        listFactors: async () =>
          estado.erroNosFatores
            ? { data: null, error: new Error("rede") }
            : { data: { totp: estado.fatores }, error: null },
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            maybeSingle: async () => ({
              data: { user_id: "u1", scope: "full", mfa_required: estado.mfaRequired, revoked_at: null },
            }),
          }),
        }),
      }),
    }),
  }),
}));

async function destino(): Promise<string | null> {
  const { requirePlatformAdmin, EscritaDePlatformAdminNegada } = await import("@/lib/auth/requirePlatformAdmin");
  try {
    await requirePlatformAdmin();
    return null;
  } catch (err) {
    // O desafio de MFA embrulha o redirect numa recusa nomeada (a rota responde
    // 403 `mfa_required`); a tela vai a `/login/mfa`, que é o que se mede aqui.
    if (err instanceof EscritaDePlatformAdminNegada && err.code === "mfa_required") return estado.ultimoRedirect;
    const m = err instanceof Error ? err.message : String(err);
    if (!m.startsWith("REDIRECT:")) throw err;
    return m.slice("REDIRECT:".length);
  }
}

beforeEach(() => {
  estado.mfaRequired = false;
  estado.nivel = "aal1";
  estado.fatores = [{ status: "verified" }];
  estado.erroNosFatores = false;
  estado.ultimoRedirect = null;
});

describe("requirePlatformAdmin e o segundo fator", () => {
  it("⭐ mfa_required desligado, mas com fator verificado e sessão aal1: vai para /login/mfa", async () => {
    expect(await destino()).toBe("/login/mfa?next=%2Fadmin"); // upstream: next = caminho atual, codificado
  });

  it("não consegue ler a sessão (nem os fatores): falha fechado, vai para o login e nunca libera", async () => {
    estado.erroNosFatores = true;
    expect(await destino()).toBe("/login?next=/admin");
  });

  it("mfa_required ligado e aal1: continua indo para /login/mfa, mesmo sem fator na lista", async () => {
    estado.mfaRequired = true;
    estado.fatores = [];
    expect(await destino()).toBe("/login/mfa?next=%2Fadmin"); // upstream: next = caminho atual, codificado
  });

  it("CONTROLE: com aal2 entra", async () => {
    estado.nivel = "aal2";
    expect(await destino()).toBeNull();
  });

  it("CONTROLE: mfa_required desligado e nenhum fator verificado, em aal1: entra (não é trancado fora)", async () => {
    estado.fatores = [{ status: "unverified" }];
    expect(await destino()).toBeNull();
  });
});
