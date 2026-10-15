/**
 * A faixa "Confirme seu e-mail": aparece só para quem tem pedido em aberto, nunca bloqueia, e o "Reenviar"
 * mostra o desfecho (inclusive os tetos de 1 por minuto e 5 por dia).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailNaoConfirmadoBanner } from "@/components/app/EmailNaoConfirmadoBanner";
import { AuthProvider } from "@/hooks/auth/AuthProvider";
import type { AuthUser } from "@/lib/auth/types";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const reenviar = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/auth/reenviarVerificacaoEmail", () => ({ reenviarVerificacaoEmail: reenviar }));
vi.mock("@/lib/supabase/browser", () => ({
  resetRealtimeAuthentication: vi.fn(),
  createClient: () => ({ auth: { refreshSession: vi.fn() } }),
}));

const base: AuthUser = {
  id: "u1",
  email: "dono@plata.test",
  full_name: null,
  avatar_url: null,
  organizations: [{ organization_id: "org", organization_name: "Plata", role: "admin" }],
  idioma: "pt-BR",
  is_platform_admin: false,
};

function ver(user: Partial<AuthUser>, locale: "pt-BR" | "es" = "pt-BR") {
  return render(
    <AuthProvider user={{ ...base, ...user }} activeOrg={{ orgId: "org", name: "Plata", role: "admin" }}>
      <IdiomaProvider locale={locale}>
        <EmailNaoConfirmadoBanner />
      </IdiomaProvider>
    </AuthProvider>,
  );
}

beforeEach(() => reenviar.mockReset());

describe("quando a faixa aparece", () => {
  it("e-mail não confirmado: mostra o endereço e o botão Reenviar", () => {
    ver({ email_verificado: false });
    const faixa = screen.getByTestId("email-nao-confirmado");
    expect(faixa).toHaveTextContent("Confirme seu e-mail: enviamos um link para dono@plata.test.");
    expect(screen.getByRole("button", { name: "Reenviar" })).toBeEnabled();
  });

  it.each([
    ["confirmado", { email_verificado: true }],
    ["conta antiga (campo ausente)", {}],
    ["acesso de suporte", { email_verificado: false, support: { id: "s" } as never }],
    ["sem e-mail", { email_verificado: false, email: "" }],
  ])("não aparece: %s", (_nome, user) => {
    ver(user as Partial<AuthUser>);
    expect(screen.queryByTestId("email-nao-confirmado")).toBeNull();
  });

  it("em espanhol", () => {
    ver({ email_verificado: false }, "es");
    expect(screen.getByTestId("email-nao-confirmado")).toHaveTextContent("Confirma tu correo: enviamos un enlace a dono@plata.test.");
  });

  it("nunca bloqueia: não é modal nem alerta que tome o foco", () => {
    ver({ email_verificado: false });
    const faixa = screen.getByTestId("email-nao-confirmado");
    expect(faixa).toHaveAttribute("role", "status");
    expect(faixa.closest("[aria-modal]")).toBeNull();
  });
});

describe("Reenviar", () => {
  it.each([
    [{ ok: true }, "Link reenviado. Confira sua caixa de entrada."],
    [{ ok: false, error: "muito_cedo" }, "Aguarde 1 minuto para pedir outro link."],
    [{ ok: false, error: "limite_diario" }, "Você chegou ao limite de 5 reenvios por dia. Tente amanhã."],
    [{ ok: false, error: "ja_confirmado" }, "Seu e-mail já está confirmado."],
    [{ ok: false, error: "send_failed" }, "Não foi possível reenviar agora. Tente de novo em instantes."],
  ])("desfecho %j mostra a mensagem certa", async (resultado, texto) => {
    reenviar.mockResolvedValue(resultado);
    ver({ email_verificado: false });
    await userEvent.setup().click(screen.getByRole("button", { name: "Reenviar" }));
    await waitFor(() => expect(screen.getByTestId("email-nao-confirmado-aviso")).toHaveTextContent(texto));
    expect(reenviar).toHaveBeenCalledTimes(1);
  });
});
