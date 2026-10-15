/**
 * O cadastro sem confirmação do provedor: aceite dos Termos obrigatório, dica do plano, e a verificação de
 * e-mail do CRM. Atravessa a ação inteira (`signUp` → envio → pedido gravado no `app_metadata`) com o
 * provedor de auth e o transporte de e-mail como únicas bordas falsas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { consumirToken, emailVerificado, pedidoEmAberto } from "@/lib/auth/verificacao-email";
import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";

import { criarAuthAdminFalso } from "./helpers/auth-admin-falso";

const bordas = vi.hoisted(() => ({
  admin: null as unknown,
  enviar: vi.fn(),
  /** A compra do plano pelo cliente está ligada nesta instalação? (o aceite e a verificação só existem então) */
  compraLigada: true,
}));

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => bordas.admin }));
vi.mock("@/lib/onboarding/precisa-pagar", () => ({ compraPeloClienteDisponivel: async () => bordas.compraLigada }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: vi.fn(async () => "aberto") }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: (...a: unknown[]) => bordas.enviar(...a) }));
vi.mock("@/lib/branding/saida", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  marcaDaSaida: async () => ({ nome: "HiperCRM", logoUrl: null, accent: "#0f766e", accentFg: "#ffffff" }),
}));

const signUpDoProvedor = vi.fn();
let n = 0;

function entrada(extra: Record<string, unknown> = {}) {
  n += 1;
  return {
    org_name: "Plata Iphones",
    email: `cadastro-${n}-${Date.now()}@exemplo.test`,
    password: "SenhaForte!2026",
    password_confirm: "SenhaForte!2026",
    aceite_termos: true as const,
    ...extra,
  };
}

const USER = "11111111-1111-4111-8111-111111111111";
const agoraIso = () => new Date().toISOString();

function usuarioNovo(email: string, extra: Record<string, unknown> = {}) {
  return { id: USER, email, created_at: agoraIso(), identities: [{ id: "i1" }], ...extra };
}

beforeEach(() => {
  vi.resetModules();
  signUpDoProvedor.mockReset();
  bordas.enviar.mockReset();
  bordas.compraLigada = true;
  bordas.enviar.mockResolvedValue({ ok: true, id: "m1" });
  vi.mocked(headers).mockResolvedValue({
    get: (k: string) => (k === "x-forwarded-for" ? `203.0.113.${n % 250}` : k === "accept-language" ? "pt-BR" : null),
  } as never);
  vi.mocked(createClient).mockResolvedValue({ auth: { signUp: signUpDoProvedor } } as never);
  vi.mocked(modoDeCadastro).mockResolvedValue("aberto");
});

describe("aceite dos Termos no cadastro", () => {
  it("sem o aceite o cadastro é recusado ANTES de falar com o provedor (a ação é chamável direto)", async () => {
    const { signUp } = await import("@/app/actions/auth/signUp");
    const dados = entrada();
    const res = await signUp({ ...dados, aceite_termos: false } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("validation_error");
      expect(res.details).toHaveProperty("aceite_termos");
    }
    expect(signUpDoProvedor).not.toHaveBeenCalled();

    const { aceite_termos: _fora, ...semCampo } = dados;
    void _fora;
    const res2 = await signUp(semCampo as never);
    expect(res2.ok).toBe(false);
    expect(signUpDoProvedor).not.toHaveBeenCalled();
  });

  it.each([["verdadeiro em texto", "true"], ["um", 1], ["texto", "sim"]])(
    "só o booleano true vale (%s é recusado)",
    async (_nome, valor) => {
      const { signUp } = await import("@/app/actions/auth/signUp");
      const res = await signUp({ ...entrada(), aceite_termos: valor } as never);
      expect(res.ok).toBe(false);
      expect(signUpDoProvedor).not.toHaveBeenCalled();
    },
  );

  it("com o aceite, grava versão e hora DO SERVIDOR no app_metadata, e o valor enviado pelo navegador não entra", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "x", app_metadata: { provider: "email" } }]);
    bordas.admin = f.cliente;
    const dados = entrada({ aceite_termos_em: "1999-01-01T00:00:00Z", terms_version: "1999-01-01" });
    signUpDoProvedor.mockResolvedValue({ data: { user: usuarioNovo(dados.email), session: null }, error: null });

    const { signUp } = await import("@/app/actions/auth/signUp");
    const antes = Date.now();
    const res = await signUp(dados);
    expect(res).toEqual({ ok: true, sessao_ativa: false });

    const aceite = f.appMetadata(USER).aceite_termos as { versao: string; aceito_em: string };
    expect(aceite.versao).toBe(VERSAO_DOS_TERMOS);
    expect(Date.parse(aceite.aceito_em)).toBeGreaterThanOrEqual(antes - 1000);
    expect(Date.parse(aceite.aceito_em)).toBeLessThanOrEqual(Date.now() + 1000);
    // Com a confirmação do provedor ligada o e-mail é o dele: o CRM não manda o seu nem abre pedido.
    expect(bordas.enviar).not.toHaveBeenCalled();
    expect(pedidoEmAberto(f.appMetadata(USER))).toBeNull();
  });

  it("COM convite o cadastro não exige nem grava aceite (comportamento de antes)", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "x", app_metadata: { provider: "email" } }]);
    bordas.admin = f.cliente;
    const { signInviteToken, INVITE_TTL_SECONDS } = await import("@/lib/auth/invite-token");
    const dados = entrada();
    const token = signInviteToken({
      invite_id: "00000000-0000-4000-8000-000000000003",
      email: dados.email,
      organization_id: "00000000-0000-4000-8000-000000000001",
      role: "agent",
      exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
    });
    signUpDoProvedor.mockResolvedValue({
      data: { user: usuarioNovo(dados.email), session: { access_token: "t" } },
      error: null,
    });

    const { signUp } = await import("@/app/actions/auth/signUp");
    const res = await signUp(
      { full_name: "Convidada", email: dados.email, password: dados.password, password_confirm: dados.password_confirm },
      token,
    );
    expect(res).toEqual({ ok: true, sessao_ativa: true });
    expect(f.escritas).toHaveLength(0);
    expect(bordas.enviar).not.toHaveBeenCalled();
    expect(signUpDoProvedor.mock.calls[0]![0].options.data).not.toHaveProperty("plano_escolhido");
  });
});

describe("compra pelo cliente DESLIGADA: a instalação cadastra como antes", () => {
  beforeEach(() => {
    bordas.compraLigada = false;
  });

  it("⭐ não exige o aceite dos Termos: sem o campo (ou com false) o cadastro passa", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "x", app_metadata: { provider: "email" } }]);
    bordas.admin = f.cliente;
    const { signUp } = await import("@/app/actions/auth/signUp");
    const { aceite_termos: _fora, ...semCampo } = entrada();
    void _fora;
    signUpDoProvedor.mockResolvedValue({ data: { user: usuarioNovo("a@b.test"), session: null }, error: null });
    expect(await signUp(semCampo)).toEqual({ ok: true, sessao_ativa: false });
    expect(await signUp({ ...entrada(), aceite_termos: false } as never)).toEqual({ ok: true, sessao_ativa: false });
    expect(signUpDoProvedor).toHaveBeenCalledTimes(2);
  });

  it("⭐ não grava aceite no app_metadata nem manda e-mail de verificação, mesmo com a sessão aberta", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "dono@plata.test", app_metadata: { provider: "email" } }]);
    bordas.admin = f.cliente;
    signUpDoProvedor.mockResolvedValue({
      data: { user: usuarioNovo("dono@plata.test"), session: { access_token: "t" } },
      error: null,
    });
    const { signUp } = await import("@/app/actions/auth/signUp");
    expect(await signUp(entrada())).toEqual({ ok: true, sessao_ativa: true });
    expect(f.escritas).toHaveLength(0);
    expect(bordas.enviar).not.toHaveBeenCalled();
    expect(pedidoEmAberto(f.appMetadata(USER))).toBeNull();
  });
});

describe("plano escolhido (dica)", () => {
  it("vai para o user_metadata.plano_escolhido já sanitizado; lixo é descartado sem recusar o cadastro", async () => {
    signUpDoProvedor.mockResolvedValue({ data: { user: { id: USER }, session: null }, error: null });
    const { signUp } = await import("@/app/actions/auth/signUp");

    await signUp(entrada({ plano_escolhido: " MAX " }));
    expect(signUpDoProvedor.mock.calls[0]![0].options.data).toEqual({ org_name: "Plata Iphones", plano_escolhido: "max" });

    signUpDoProvedor.mockClear();
    const res = await signUp(entrada({ plano_escolhido: "<script>x</script>" }));
    expect(res.ok).toBe(true);
    expect(signUpDoProvedor.mock.calls[0]![0].options.data).toEqual({ org_name: "Plata Iphones" });
  });
});

describe("verificação de e-mail do CRM no cadastro", () => {
  it("sessão aberta (confirmação do provedor desligada): manda o e-mail com o link e grava só o hash", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "dono@plata.test", app_metadata: { provider: "email" } }]);
    bordas.admin = f.cliente;
    signUpDoProvedor.mockResolvedValue({
      data: { user: usuarioNovo("dono@plata.test"), session: { access_token: "t" } },
      error: null,
    });

    const { signUp } = await import("@/app/actions/auth/signUp");
    const res = await signUp(entrada({ plano_escolhido: "pro" }));
    expect(res).toEqual({ ok: true, sessao_ativa: true });

    expect(bordas.enviar).toHaveBeenCalledTimes(1);
    const email = bordas.enviar.mock.calls[0]![0] as { to: string; html: string };
    expect(email.to).toBe("dono@plata.test");
    const token = decodeURIComponent(/token=([^"&\s]+)/.exec(email.html)![1]!);
    const meta = f.appMetadata(USER);
    expect(emailVerificado(meta)).toBe(false);
    expect(JSON.stringify(meta)).not.toContain(token.split(".")[1]);
    expect((meta.aceite_termos as { versao: string }).versao).toBe(VERSAO_DOS_TERMOS);

    // O link abre e a conta passa a verificada.
    expect((await consumirToken({ admin: f.cliente, token })).ok).toBe(true);
    expect(emailVerificado(f.appMetadata(USER))).toBe(true);
  });

  it("falha ao mandar o e-mail NÃO derruba o cadastro", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "dono@plata.test", app_metadata: {} }]);
    bordas.admin = f.cliente;
    bordas.enviar.mockRejectedValue(new Error("smtp caiu"));
    signUpDoProvedor.mockResolvedValue({
      data: { user: usuarioNovo("dono@plata.test"), session: { access_token: "t" } },
      error: null,
    });
    const { signUp } = await import("@/app/actions/auth/signUp");
    expect(await signUp(entrada())).toEqual({ ok: true, sessao_ativa: true });
  });

  it("falha do provedor ao gravar NÃO derruba o cadastro", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "dono@plata.test", app_metadata: {} }]);
    f.falharGravacao(true);
    bordas.admin = f.cliente;
    signUpDoProvedor.mockResolvedValue({
      data: { user: usuarioNovo("dono@plata.test"), session: { access_token: "t" } },
      error: null,
    });
    const { signUp } = await import("@/app/actions/auth/signUp");
    expect(await signUp(entrada())).toEqual({ ok: true, sessao_ativa: true });
    expect(bordas.enviar).not.toHaveBeenCalled();
  });

  it("e-mail que já tinha conta: o usuário devolvido é ofuscado ou antigo, e NADA é escrito nele", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "dono@plata.test", app_metadata: { provider: "email" } }]);
    bordas.admin = f.cliente;
    const { signUp } = await import("@/app/actions/auth/signUp");

    // Ofuscado: sem identities.
    signUpDoProvedor.mockResolvedValueOnce({
      data: { user: usuarioNovo("dono@plata.test", { identities: [] }), session: null },
      error: null,
    });
    expect((await signUp(entrada())).ok).toBe(true);

    // Conta antiga ainda não confirmada: id real, criada há dias.
    signUpDoProvedor.mockResolvedValueOnce({
      data: {
        user: usuarioNovo("dono@plata.test", { created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
        session: { access_token: "t" },
      },
      error: null,
    });
    expect((await signUp(entrada())).ok).toBe(true);

    expect(f.escritas).toHaveLength(0);
    expect(bordas.enviar).not.toHaveBeenCalled();
  });
});
