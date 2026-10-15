/**
 * A ação "Reenviar e-mail de confirmação": só para quem está logado, sempre para o e-mail da PRÓPRIA conta,
 * com os tetos de 1 por minuto e 5 por dia.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { emailVerificado, emitirPedido } from "@/lib/auth/verificacao-email";

import { criarAuthAdminFalso } from "./helpers/auth-admin-falso";

const bordas = vi.hoisted(() => ({ admin: null as unknown, enviar: vi.fn() }));

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => bordas.admin }));
// A verificação de e-mail do CRM só existe com a compra pelo cliente ligada (a recusa sem ela: reenviar-verificacao-so-com-compra-ligada.test.ts).
vi.mock("@/lib/onboarding/precisa-pagar", () => ({ compraPeloClienteDisponivel: async () => true }));
vi.mock("@/lib/audit", async (orig) => ({ ...(await orig<Record<string, unknown>>()), audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: (...a: unknown[]) => bordas.enviar(...a) }));
vi.mock("@/lib/branding/saida", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  marcaDaSaida: async () => ({ nome: "HiperCRM", logoUrl: null, accent: "#0f766e", accentFg: "#ffffff" }),
}));

let n = 0;
const novoId = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`;

function logado(id: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: id ? { id, user_metadata: {} } : null } }) },
  } as never);
}

beforeEach(() => {
  vi.resetModules();
  bordas.enviar.mockReset();
  bordas.enviar.mockResolvedValue({ ok: true, id: "m1" });
  vi.mocked(headers).mockResolvedValue({ get: () => null } as never);
});

describe("reenviarVerificacaoEmail", () => {
  it("sem sessão: auth_required, e nada é enviado", async () => {
    logado(null);
    bordas.admin = criarAuthAdminFalso([]).cliente;
    const { reenviarVerificacaoEmail } = await import("@/app/actions/auth/reenviarVerificacaoEmail");
    expect(await reenviarVerificacaoEmail()).toEqual({ ok: false, error: "auth_required" });
    expect(bordas.enviar).not.toHaveBeenCalled();
  });

  it("conta com pedido em aberto: envia para o e-mail DA CONTA e troca o link", async () => {
    const id = novoId();
    const f = criarAuthAdminFalso([{ id, email: "dono@plata.test", app_metadata: {} }]);
    bordas.admin = f.cliente;
    // Cadastro de 5 minutos atrás: o último envio já passou do minuto.
    await emitirPedido({ admin: f.cliente, userId: id, agora: new Date(Date.now() - 5 * 60_000) });
    logado(id);

    const { reenviarVerificacaoEmail } = await import("@/app/actions/auth/reenviarVerificacaoEmail");
    expect(await reenviarVerificacaoEmail()).toEqual({ ok: true });
    expect(bordas.enviar).toHaveBeenCalledTimes(1);
    expect((bordas.enviar.mock.calls[0]![0] as { to: string }).to).toBe("dono@plata.test");
    expect(emailVerificado(f.appMetadata(id))).toBe(false);
  });

  it("segundo clique em seguida: muito_cedo, e só um e-mail sai", async () => {
    const id = novoId();
    const f = criarAuthAdminFalso([{ id, email: "dono@plata.test", app_metadata: {} }]);
    bordas.admin = f.cliente;
    await emitirPedido({ admin: f.cliente, userId: id, agora: new Date(Date.now() - 5 * 60_000) });
    logado(id);

    const { reenviarVerificacaoEmail } = await import("@/app/actions/auth/reenviarVerificacaoEmail");
    expect(await reenviarVerificacaoEmail()).toEqual({ ok: true });
    expect(await reenviarVerificacaoEmail()).toEqual({ ok: false, error: "muito_cedo" });
    expect(bordas.enviar).toHaveBeenCalledTimes(1);
  });

  it("conta antiga, sem pedido: ja_confirmado, nada enviado e nenhum pedido criado", async () => {
    const id = novoId();
    const f = criarAuthAdminFalso([{ id, email: "velha@plata.test", app_metadata: { provider: "email" } }]);
    bordas.admin = f.cliente;
    logado(id);
    const { reenviarVerificacaoEmail } = await import("@/app/actions/auth/reenviarVerificacaoEmail");
    expect(await reenviarVerificacaoEmail()).toEqual({ ok: false, error: "ja_confirmado" });
    expect(bordas.enviar).not.toHaveBeenCalled();
    expect(f.escritas).toHaveLength(0);
  });

  it("transporte de e-mail fora do ar: send_failed, sem lançar", async () => {
    const id = novoId();
    const f = criarAuthAdminFalso([{ id, email: "dono@plata.test", app_metadata: {} }]);
    bordas.admin = f.cliente;
    await emitirPedido({ admin: f.cliente, userId: id, agora: new Date(Date.now() - 5 * 60_000) });
    bordas.enviar.mockResolvedValue({ ok: false, error: "send_failed" });
    logado(id);
    const { reenviarVerificacaoEmail } = await import("@/app/actions/auth/reenviarVerificacaoEmail");
    expect(await reenviarVerificacaoEmail()).toEqual({ ok: false, error: "send_failed" });
  });
});
