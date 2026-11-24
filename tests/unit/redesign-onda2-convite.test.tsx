/**
 * ONDA 2 DO REDESIGN — o convite no v49.
 *
 * Com a chave ligada, o convite ganha a casca das telas de entrada (logo da
 * marca e o painel azul do lado), diz o PAPEL com que a pessoa vai entrar e o
 * convite vencido deixa de falar em "admin do tenant".
 *
 * Só usa o que o token já traz (e-mail e papel). Nome da empresa e de quem
 * convidou exigiriam ler o banco numa página aberta: fica para o produto.
 *
 * Desligada, o HTML é o de sempre.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signInviteToken, type InvitePayload } from "@/lib/auth/invite-token";

const h = vi.hoisted(() => ({ ligado: false, user: null as unknown }));

vi.mock("@/lib/redesign/chave", () => ({ redesignNaRequisicao: async () => h.ligado }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}));
vi.mock("@/lib/auth/rate-limit", () => ({ authRateLimited: async () => false, AUTH_LIMITS: { invite_accept: {} } }));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Marca Teste", logoUrl: null, accent: "#123456" }),
}));
vi.mock("@/app/actions/team/acceptInvite", () => ({ acceptInviteAction: vi.fn() }));
vi.mock("@/app/team/accept-invite/[token]/ReenviarVerificacaoNoConvite", () => ({
  ReenviarVerificacaoNoConvite: () => null,
}));

import AcceptInvitePage from "@/app/team/accept-invite/[token]/page";

const agora = Math.floor(Date.now() / 1000);
const payload: InvitePayload = {
  invite_id: "22222222-2222-4222-8222-222222222222",
  email: "convidada@example.com",
  organization_id: "33333333-3333-4333-8333-333333333333",
  role: "agent",
  iat: agora,
  exp: agora + 3600,
  invited_by: "44444444-4444-4444-8444-444444444444",
};
const VALIDO = signInviteToken(payload);
const VENCIDO = signInviteToken({ ...payload, iat: agora - 7200, exp: agora - 3600 });

async function pagina(token: string) {
  return AcceptInvitePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) });
}

afterEach(() => {
  cleanup();
  h.ligado = false;
  h.user = null;
});

describe("onda 2 — convite, chave DESLIGADA", () => {
  it.each([
    ["convite válido, sem sessão", VALIDO],
    ["convite vencido", VENCIDO],
  ])("%s: HTML idêntico ao de sempre", async (_nome, token) => {
    const html = renderToStaticMarkup(await pagina(token));
    expect(html).toMatchSnapshot();
    expect(html).not.toContain("data-rd-entrar");
  });
});

describe("onda 2 — convite, chave LIGADA", () => {
  it("usa a casca das telas de entrada: painel azul e logo da marca", async () => {
    h.ligado = true;
    const { container } = render(await pagina(VALIDO));
    expect(container.querySelector('[data-rd-entrar="pagina"]')).not.toBeNull();
    expect(container.querySelector('[data-rd-entrar="painel"]')).not.toBeNull();
    expect(container.querySelector('[data-rd-entrar="cartao"]')).not.toBeNull();
    expect(container.querySelector('[data-rd-entrar="logo"]')?.textContent).toContain("Marca Teste");
  });

  it("diz o papel com que a pessoa vai entrar, e o e-mail do convite", async () => {
    h.ligado = true;
    render(await pagina(VALIDO));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Você foi convidado para entrar como Atendente");
    expect(screen.getByText(payload.email)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Criar minha conta" })).toBeTruthy();
  });

  it("convite vencido fala com gente, não em 'admin do tenant'", async () => {
    h.ligado = true;
    const html = renderToStaticMarkup(await pagina(VENCIDO));
    expect(html).not.toContain("tenant");
    expect(html).toContain("Peça um novo convite a quem administra a sua empresa.");
  });
});
