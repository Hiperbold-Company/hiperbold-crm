/**
 * O CARTÃO "CONFIRMAR SEU E-MAIL" DO INÍCIO TEM O REENVIO — NÃO MANDA PARA UMA TELA SEM SAÍDA.
 *
 * O passo apontava para `/app/settings/profile`, que não tem botão de reenvio. Aqui a página real
 * `/app/inicio` é montada (dublê só em sessão, leitura dos passos e na ação de reenvio) e o que se mede é
 * o que a pessoa vê e consegue fazer no cartão: pendente = botão que dispara o reenvio; feito = link.
 *
 * Comando: npx vitest run tests/unit/inicio-email-pendente-reenvia-no-cartao.test.tsx
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  emailFeito: false,
  reenviar: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (d: string) => {
    throw new Error(`NEXT_REDIRECT:${d}`);
  },
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u1", idioma: "pt-BR", is_platform_admin: false, support: null }),
  resolveActiveOrg: async () => ({ orgId: "o1", name: "QA", role: "admin" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/app/actions/auth/reenviarVerificacaoEmail", () => ({
  reenviarVerificacaoEmail: (...a: unknown[]) => h.reenviar(...a),
}));
vi.mock("@/lib/inicio/carregar", async () => {
  const { primeirosPassos } = await import("@/lib/inicio/primeiros-passos");
  return {
    carregarPrimeirosPassos: async () =>
      primeirosPassos({
        compraLigada: true,
        planoAtivo: true,
        emailVerificado: h.emailFeito,
        oQueFaz: null,
        fuso: null,
        whatsappConectado: false,
        agentePublicado: false,
        marcaPorOrganizacaoLigada: false,
        logoDefinido: false,
        followupAtivo: false,
        membrosAtivos: 1,
      }),
  };
});

import InicioPage from "@/app/app/inicio/page";

beforeEach(() => {
  h.emailFeito = false;
  h.reenviar.mockReset();
  h.reenviar.mockResolvedValue({ ok: true });
});

describe("/app/inicio: cartão 'Confirmar seu e-mail'", () => {
  it("⭐ pendente: mostra o botão de reenvio (não um link para o perfil) e ele dispara o reenvio", async () => {
    render(await InicioPage());
    const cartao = screen.getByTestId("inicio-passo-email");
    expect(cartao.querySelector('a[href="/app/settings/profile"]')).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /enviar um link novo/i }));
    await waitFor(() => expect(h.reenviar).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Link reenviado/i)).toBeTruthy();
  });

  it("feito: sem botão de reenvio, só o link para rever o perfil", async () => {
    h.emailFeito = true;
    render(await InicioPage());
    const cartao = screen.getByTestId("inicio-passo-email");
    expect(cartao.querySelector('a[href="/app/settings/profile"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: /enviar um link novo/i })).toBeNull();
  });

  it("os outros cartões pendentes continuam com o link de sempre", async () => {
    render(await InicioPage());
    const perfil = screen.getByTestId("inicio-passo-perfil");
    expect(perfil.querySelector('a[href^="/app/settings/tenant"]')).not.toBeNull();
  });
});
