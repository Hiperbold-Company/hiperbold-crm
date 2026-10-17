import { describe, expect, it } from "vitest";

import {
  contaPrecisaSerRetomada,
  googleProvouOEmail,
  retomarContaPeloGoogle,
  senhaAleatoriaForte,
  type UsuarioDoRetorno,
} from "@/lib/auth/retomar-conta-pelo-google";

import { gotrueFalso, type OpcoesDoGotrueFalso } from "./helpers/gotrue-admin-falso";

/**
 * D-204: a regra que decide quando a entrada com Google reassume uma conta cadastrada por e-mail.
 * Pura nas decisões; as etapas administrativas (senha, outras sessões, carimbo) rodam contra um GoTrue falso
 * que registra a ORDEM, porque a ordem é a segurança (carimbar antes de derrubar o atacante a anula).
 */

const PEDIDO = { hash: "h", expira_em: "2099-01-01T00:00:00Z", enviado_em: "2026-10-17T00:00:00Z" };

function usuario(sobre: Partial<UsuarioDoRetorno> = {}): UsuarioDoRetorno {
  return {
    id: "u1",
    email: "Vitima@Empresa.com",
    app_metadata: { provider: "email", email_verificacao: PEDIDO },
    identities: [
      { provider: "email", identity_data: { email: "vitima@empresa.com" } },
      { provider: "google", identity_data: { email: "vitima@empresa.com", email_verified: true } },
    ],
    ...sobre,
  };
}

describe("googleProvouOEmail", () => {
  it("aceita identidade do Google verificada com o mesmo endereço (sem diferenciar maiúsculas)", () => {
    expect(googleProvouOEmail(usuario())).toBe(true);
  });

  it.each([
    ["sem identidade do Google", { identities: [{ provider: "email", identity_data: { email: "vitima@empresa.com" } }] }],
    ["identities ausente", { identities: null }],
    [
      "e-mail do Google não verificado",
      { identities: [{ provider: "google", identity_data: { email: "vitima@empresa.com", email_verified: false } }] },
    ],
    [
      "email_verified como texto (não é o booleano true)",
      { identities: [{ provider: "google", identity_data: { email: "vitima@empresa.com", email_verified: "true" } }] },
    ],
    [
      "endereço do Google diferente do da conta",
      { identities: [{ provider: "google", identity_data: { email: "outro@empresa.com", email_verified: true } }] },
    ],
    ["conta sem e-mail", { email: null }],
  ] as Array<[string, Partial<UsuarioDoRetorno>]>)("recusa: %s", (_nome, sobre) => {
    expect(googleProvouOEmail(usuario(sobre))).toBe(false);
  });
});

describe("contaPrecisaSerRetomada", () => {
  it("pedido em aberto + Google provou o endereço: retoma", () => {
    expect(contaPrecisaSerRetomada(usuario())).toBe(true);
  });

  it("sem pedido em aberto (Google desde o início, convite, conta antiga): não toca", () => {
    expect(contaPrecisaSerRetomada(usuario({ app_metadata: { provider: "google" } }))).toBe(false);
  });

  it("pedido em aberto MAS já carimbado: não toca", () => {
    const u = usuario({ app_metadata: { email_verificacao: PEDIDO, email_verificado_em: "2026-10-17T00:00:00Z" } });
    expect(contaPrecisaSerRetomada(u)).toBe(false);
  });

  it("pedido em aberto mas o Google NÃO provou o endereço: não toca", () => {
    expect(contaPrecisaSerRetomada(usuario({ identities: [] }))).toBe(false);
  });

  it("o carimbo em user_metadata (que a própria pessoa grava) não conta", () => {
    const u = { ...usuario(), user_metadata: { email_verificado_em: "2026-10-17T00:00:00Z" } };
    expect(contaPrecisaSerRetomada(u)).toBe(true);
  });
});

describe("senhaAleatoriaForte", () => {
  it("não repete e tem tamanho de sobra", () => {
    const a = senhaAleatoriaForte();
    expect(a).not.toBe(senhaAleatoriaForte());
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a.length).toBeLessThanOrEqual(72); // teto do bcrypt
  });
});

describe("retomarContaPeloGoogle", () => {
  function gotrue(opcoes: OpcoesDoGotrueFalso = {}) {
    const f = gotrueFalso(opcoes);
    return { ...f, passa: f.admin as unknown as Parameters<typeof retomarContaPeloGoogle>[0]["admin"] };
  }

  it("ordem: senha, fatores de MFA, outras sessões, carimbo; preserva a sessão nova", async () => {
    const { admin, chamadas, passa } = gotrue({ fatores: [{ id: "f1", status: "unverified" }] });
    const r = await retomarContaPeloGoogle({
      admin: passa,
      usuario: usuario(),
      accessToken: "jwt-novo",
      gerarSenha: () => "S3nha!",
    });
    expect(r).toEqual({ ok: true, retomada: true, fatoresRemovidos: 1, sessaoEncerrada: false });
    expect(chamadas).toEqual(["senha", "fatores", "sessoes", "carimbo"]);
    expect(admin.auth.admin.signOut).toHaveBeenCalledWith("jwt-novo", "others");
    expect(admin.auth.admin.updateUserById).toHaveBeenNthCalledWith(1, "u1", { password: "S3nha!" });
    expect(admin.auth.admin.mfa.deleteFactor).toHaveBeenCalledWith({ userId: "u1", id: "f1" });
  });

  it("fator verificado removido: o provedor já encerrou as sessões, então não derruba 'others' e avisa", async () => {
    const { chamadas, passa } = gotrue({ fatores: [{ id: "f1", status: "verified" }] });
    const r = await retomarContaPeloGoogle({ admin: passa, usuario: usuario(), accessToken: "jwt" });
    expect(r).toEqual({ ok: true, retomada: true, fatoresRemovidos: 1, sessaoEncerrada: true });
    expect(chamadas).toEqual(["senha", "fatores", "carimbo"]);
  });

  it("o carimbo grava em app_metadata (nunca user_metadata) e remove o pedido com null explícito", async () => {
    const { admin, passa } = gotrue();
    await retomarContaPeloGoogle({
      admin: passa,
      usuario: usuario(),
      accessToken: "jwt",
      agora: new Date("2026-10-17T12:00:00Z"),
    });
    const gravado = admin.auth.admin.updateUserById.mock.calls[1]![1] as {
      app_metadata: Record<string, unknown>;
      user_metadata?: unknown;
    };
    expect(gravado.user_metadata).toBeUndefined();
    expect(gravado.app_metadata.email_verificado_em).toBe("2026-10-17T12:00:00.000Z");
    expect(gravado.app_metadata.email_verificacao).toBeNull();
  });

  it.each([
    ["senha", ["senha"]],
    ["fatores", ["senha", "fatores"]],
    ["sessoes", ["senha", "fatores", "sessoes"]],
    ["gravacao", ["senha", "fatores", "sessoes", "carimbo"]],
  ] as const)("falha em %s: não avança e não carimba", async (falharEm, esperado) => {
    const { chamadas, estado, passa } = gotrue({ falharEm });
    const r = await retomarContaPeloGoogle({ admin: passa, usuario: usuario(), accessToken: "jwt" });
    expect(r.ok).toBe(false);
    expect(chamadas).toEqual(esperado);
    expect(estado.app_metadata.email_verificado_em).toBeUndefined();
  });

  it("sem o token da sessão nova: recusa antes de mexer em qualquer coisa", async () => {
    const { chamadas, passa } = gotrue();
    const r = await retomarContaPeloGoogle({ admin: passa, usuario: usuario(), accessToken: null });
    expect(r).toEqual({ ok: false, etapa: "sem_sessao" });
    expect(chamadas).toEqual([]);
  });

  it("conta que não precisa: ok sem tocar no provedor, mesmo sem token", async () => {
    const { chamadas, passa } = gotrue();
    const r = await retomarContaPeloGoogle({
      admin: passa,
      usuario: usuario({ app_metadata: { provider: "google" } }),
      accessToken: null,
    });
    expect(r).toEqual({ ok: true, retomada: false, fatoresRemovidos: 0, sessaoEncerrada: false });
    expect(chamadas).toEqual([]);
  });
});
