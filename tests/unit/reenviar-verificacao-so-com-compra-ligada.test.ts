/**
 * A VERIFICAÇÃO DE E-MAIL DO CRM SÓ EXISTE COM A COMPRA PELO CLIENTE LIGADA.
 *
 * Instalação própria (compra desligada) cadastra como antes: nenhum pedido de verificação nasce, nem pelo
 * "Reenviar". Código real de `reenviarVerificacaoEmail`; dublê só na sessão, na pergunta "compra ligada?" e
 * no envio (a borda que escreve no provedor e manda o e-mail).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ compraLigada: true, enviar: vi.fn() }));

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", user_metadata: {} } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/onboarding/precisa-pagar", () => ({ compraPeloClienteDisponivel: async () => h.compraLigada }));
vi.mock("@/lib/auth/enviar-verificacao-email", () => ({ enviarVerificacaoDeEmail: (...a: unknown[]) => h.enviar(...a) }));

import { reenviarVerificacaoEmail } from "@/app/actions/auth/reenviarVerificacaoEmail";

beforeEach(() => {
  h.compraLigada = true;
  h.enviar.mockReset();
  h.enviar.mockResolvedValue({ ok: true });
});

describe("reenviarVerificacaoEmail", () => {
  it("⭐ compra desligada: recusa e NÃO abre pedido nem manda e-mail", async () => {
    h.compraLigada = false;
    expect(await reenviarVerificacaoEmail()).toEqual({ ok: false, error: "send_failed" });
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("compra ligada: envia normalmente", async () => {
    expect(await reenviarVerificacaoEmail()).toEqual({ ok: true });
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });
});
