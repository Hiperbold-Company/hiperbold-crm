/**
 * D-204: a tela de aceite só dispensa a confirmação do e-mail para o link que chegou POR E-MAIL (`?v=` válido para
 * ESTE convite). O `accept_url` da tela do admin (sem `v`) com pedido de verificação aberto continua na tela
 * "Confirme seu e-mail", e o `v` sobrevive ao desvio por login/cadastro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { provaDoEmailDoConvite, signInviteToken, type InvitePayload } from "@/lib/auth/invite-token";

const h = vi.hoisted(() => ({ user: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: async () => false,
  AUTH_LIMITS: { invite_accept: {} },
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));
vi.mock("@/app/actions/team/acceptInvite", () => ({ acceptInviteAction: vi.fn() }));
vi.mock("./ReenviarVerificacaoNoConvite", () => ({ ReenviarVerificacaoNoConvite: () => null }));

import AcceptInvitePage from "./page";

const payload: InvitePayload = {
  invite_id: "22222222-2222-4222-8222-222222222222",
  email: "convidada@example.com",
  organization_id: "33333333-3333-4333-8333-333333333333",
  role: "agent",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  invited_by: "44444444-4444-4444-8444-444444444444",
};
const token = signInviteToken(payload);
const PEDIDO = { hash: "h", expira_em: "2099-01-01T00:00:00Z", enviado_em: "2026-10-17T00:00:00Z" };

async function abrir(v?: string) {
  const el = await AcceptInvitePage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(v === undefined ? {} : { v }),
  });
  // Árvore de elementos serializada: as props (token, prova, href) e os textos entram na busca.
  return JSON.stringify(el, (chave, valor) => {
    if (chave.startsWith("_")) return undefined;
    // `type` de componente (Link etc.) pode ser objeto circular; só importa o das tags nativas.
    if (chave === "type" && typeof valor !== "string") return "componente";
    return valor;
  });
}

describe("página de aceite do convite (D-204)", () => {
  beforeEach(() => {
    h.user = { id: "u", email: payload.email, app_metadata: { email_verificacao: PEDIDO } };
  });

  it("link do e-mail (v válido) com pedido aberto: mostra o botão de aceitar, com a prova", async () => {
    const v = provaDoEmailDoConvite(payload);
    const arvore = await abrir(v);
    expect(arvore).toContain("Aceitar convite");
    expect(arvore).not.toContain("Confirme seu e-mail para aceitar o convite");
    expect(arvore).toContain(v);
  });

  it("link do admin (sem v) com pedido aberto: continua na tela de confirmar o e-mail", async () => {
    const arvore = await abrir();
    expect(arvore).toContain("Confirme seu e-mail para aceitar o convite");
  });

  it("v de outro convite ou adulterado: continua na tela de confirmar o e-mail", async () => {
    const outro = provaDoEmailDoConvite({ ...payload, invite_id: "55555555-5555-4555-8555-555555555555" });
    const boa = provaDoEmailDoConvite(payload);
    for (const v of [outro, `${boa.slice(0, -1)}${boa.endsWith("A") ? "B" : "A"}`, "lixo"]) {
      expect(await abrir(v)).toContain("Confirme seu e-mail para aceitar o convite");
    }
  });

  it("conta já verificada: aceita sem v (como antes)", async () => {
    h.user = { id: "u", email: payload.email, app_metadata: {} };
    expect(await abrir()).toContain("Aceitar convite");
  });

  it("sem sessão: o v válido atravessa o login e o cadastro; v inválido não é repassado", async () => {
    h.user = null;
    const v = provaDoEmailDoConvite(payload);
    const comV = await abrir(v);
    expect(comV).toContain(encodeURIComponent(`/team/accept-invite/${token}?v=${v}`));
    expect(comV).toContain(`&v=${v}`);
    const semV = await abrir("lixo");
    expect(semV).not.toContain("lixo");
    expect(semV).not.toContain("v=");
  });
});
