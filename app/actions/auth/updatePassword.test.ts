import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";

/**
 * D-204: redefinir a senha pelo fluxo de recuperação derruba TODAS as sessões da conta. A sessão de quem tinha a
 * senha antiga (um atacante que cadastrou o e-mail alheio, ou um ladrão de sessão) não sobrevive à troca.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));

const ENTRADA = { password: "Nova-senha1!", password_confirm: "Nova-senha1!" };

function supabaseFalso(opcoes: { outrasFalha?: boolean } = {}) {
  const ordem: string[] = [];
  const auth = {
    getUser: vi.fn(async () => ({ data: { user: { id: "u1" } } })),
    mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" } })) },
    updateUser: vi.fn(async () => {
      ordem.push("senha");
      return { error: null };
    }),
    signOut: vi.fn(async (o?: { scope?: string }) => {
      ordem.push(`signOut:${o?.scope ?? "global"}`);
      return { error: o?.scope === "others" && opcoes.outrasFalha ? { message: "x" } : null };
    }),
  };
  vi.mocked(createClient).mockResolvedValue({ auth } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { auth, ordem };
}

describe("updatePassword", () => {
  beforeEach(() => vi.clearAllMocks());

  it("troca a senha, derruba as OUTRAS sessões e só depois encerra a desta", async () => {
    const { ordem } = supabaseFalso();
    const { updatePassword } = await import("./updatePassword");

    await expect(updatePassword(ENTRADA)).rejects.toThrow("REDIRECT:/login?reset=success");

    expect(ordem).toEqual(["senha", "signOut:others", "signOut:global"]);
  });

  it("se as outras sessões não caírem, deixa rastro mas conclui a troca", async () => {
    const { ordem } = supabaseFalso({ outrasFalha: true });
    const { updatePassword } = await import("./updatePassword");

    await expect(updatePassword(ENTRADA)).rejects.toThrow("REDIRECT:/login?reset=success");

    expect(ordem).toEqual(["senha", "signOut:others", "signOut:global"]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.password_reset_failed",
        metadata: { reason: "sessoes_nao_encerradas" },
      }),
    );
  });
});
