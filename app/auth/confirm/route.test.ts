import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { gotrueFalso, PEDIDO_EM_ABERTO } from "../../../tests/unit/helpers/gotrue-admin-falso";

/**
 * GET /auth/confirm — a rota tem de TERMINAR O SERVIÇO.
 *
 * Dois defeitos medidos numa instalação real em 2026-09-10, com o mesmo
 * convidado, nas duas tentativas:
 *
 * 1. Quem confirmava o e-mail vindo de um convite era redirecionado para uma
 *    tela com um botão "Aceitar convite". Ninguém chegava a apertá-lo, e a
 *    pessoa terminava autenticada, SEM organização e SEM menu — porque o
 *    vínculo (`user_organizations`) é o que dá as duas coisas.
 *
 * 2. Clicar duas vezes no link do e-mail mandava para `/login?error=...`
 *    alguém que ESTAVA LOGADO: o token é de uso único, o segundo clique falha,
 *    mas o `@supabase/ssr` não apaga o cookie de sessão (medido em rig). A
 *    pessoa reentrava pela senha e perdia o fio do convite.
 *
 * O que NÃO pode regredir: sem token válido E sem sessão, a recusa continua
 * sendo recusa — senão a rota vira porta aberta.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: vi.fn() }));
vi.mock("@/lib/auth/convite-no-signup", () => ({ decidirConviteDoSignup: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: vi.fn(async () => "aberto") }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" } }));

const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "convidado@example.com" };
const PAYLOAD = {
  invite_id: "22222222-2222-4222-8222-222222222222",
  email: "convidado@example.com",
  organization_id: "33333333-3333-4333-8333-333333333333",
  role: "manager",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

interface Cenario {
  /** o que `verifyOtp` devolve — o `null` simula token de uso único já gasto */
  verifyOtp: { data: { user: unknown; session?: unknown }; error: { message: string } | null };
  /** o que `getUser()` devolve depois — a sessão que o 1º clique deixou */
  getUser: { data: { user: unknown } };
}

function stubSupabase(c: Cenario) {
  return {
    auth: {
      verifyOtp: vi.fn(async () => c.verifyOtp),
      exchangeCodeForSession: vi.fn(async () => c.verifyOtp),
      getUser: vi.fn(async () => c.getUser),
      signOut: vi.fn(async () => ({ error: null })),
    },
  };
}

function requisicao(qs: string) {
  return new NextRequest(`http://localhost:3000/auth/confirm?${qs}`);
}

/** O destino do redirect, sem o host — é o que o teste realmente afirma. */
function destino(res: Response): string {
  return new URL(res.headers.get("location") ?? "").pathname + new URL(res.headers.get("location") ?? "").search;
}

describe("GET /auth/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: true, membershipId: "m1", mudou: true });
    vi.mocked(modoDeCadastro).mockResolvedValue("aberto");
  });

  function comSupabase(c: Cenario) {
    vi.mocked(createClient).mockResolvedValue(
      stubSupabase(c) as unknown as Awaited<ReturnType<typeof createClient>>,
    );
  }

  it("convite válido: grava o vínculo e entra no app, sem tela intermediária", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=abc"));

    expect(vi.mocked(aplicarConvite)).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USUARIO.id, payload: PAYLOAD }),
    );
    expect(destino(res)).toBe("/app");
    // Quem foi convidado NÃO ganha organização própria.
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("segundo clique no mesmo link: mantém quem já está logado, não manda pro login", async () => {
    comSupabase({
      verifyOtp: { data: { user: null }, error: { message: "Email link is invalid or has expired" } },
      getUser: { data: { user: USUARIO } },
    });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=ja-usado"));

    expect(destino(res)).toBe("/app");
    expect(destino(res)).not.toContain("/login");
  });

  it("link inválido E sem sessão: continua sendo recusa", async () => {
    comSupabase({
      verifyOtp: { data: { user: null }, error: { message: "Email link is invalid or has expired" } },
      getUser: { data: { user: null } },
    });

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=lixo"));

    expect(destino(res)).toBe("/login?error=link_invalido");
    expect(vi.mocked(aplicarConvite)).not.toHaveBeenCalled();
  });

  it("template padrão (formato code) sem sessão: mantém o diagnóstico próprio", async () => {
    comSupabase({
      verifyOtp: { data: { user: null }, error: { message: "PKCE code verifier not found in storage" } },
      getUser: { data: { user: null } },
    });

    const { GET } = await import("./route");
    const res = await GET(requisicao("code=abc"));

    expect(destino(res)).toBe("/login?error=template_padrao");
  });

  it("vínculo falhou: degrada para a tela de aceite, nunca deixa sem saída", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok-123",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: false, motivo: "invalid_or_expired" });

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=abc"));

    expect(destino(res)).toBe("/team/accept-invite/tok-123");
  });

  it("sem convite: segue provisionando a própria organização, como antes", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({ tipo: "provisionar" });

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=abc"));

    expect(vi.mocked(ensureTenantForUser)).toHaveBeenCalledWith(USUARIO);
    expect(vi.mocked(aplicarConvite)).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/onboarding");
  });

  it("sem convite em instalação com_aprovacao: e-mail confirmado, mas a empresa espera o pedido", async () => {
    // Recorte do PR #714 (migration 0383). O e-mail acabou de ser provado pelo
    // `verifyOtp` do provedor; a empresa só nasce na aprovação do administrador.
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({ tipo: "provisionar" });
    vi.mocked(modoDeCadastro).mockResolvedValue("com_aprovacao");

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=abc"));

    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/get-started");
  });

  it("convite válido em instalação com_aprovacao: entra direto, o convite já é a aprovação", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);
    vi.mocked(modoDeCadastro).mockResolvedValue("com_aprovacao");

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=abc"));

    expect(destino(res)).toBe("/app");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  // ─── D-204: recuperação de senha sobre conta cadastrada por e-mail sem verificação ───

  const CONTA_PENDENTE = { ...USUARIO, app_metadata: { email_verificacao: PEDIDO_EM_ABERTO } };

  it("recuperação em conta com verificação em aberto: senha, fatores, outras sessões e carimbo, e segue para /login/reset", async () => {
    const falso = gotrueFalso({ fatores: [{ id: "f1", status: "unverified" }] });
    vi.mocked(createAdminClient).mockReturnValue(falso.admin as unknown as ReturnType<typeof createAdminClient>);
    comSupabase({
      verifyOtp: { data: { user: CONTA_PENDENTE, session: { access_token: "jwt-recuperacao" } }, error: null },
      getUser: { data: { user: null } },
    });

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=recovery&token_hash=abc"));

    expect(falso.chamadas).toEqual(["senha", "fatores", "sessoes", "carimbo"]);
    expect(falso.admin.auth.admin.signOut).toHaveBeenCalledWith("jwt-recuperacao", "others");
    expect(falso.removidos).toEqual(["f1"]);
    expect(typeof falso.estado.app_metadata.email_verificado_em).toBe("string");
    expect(destino(res)).toBe("/login/reset");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.account_reclaimed_by_recovery" }),
    );
  });

  it("recuperação com fator verificado: o provedor encerra a sessão de recuperação, então manda entrar de novo", async () => {
    const falso = gotrueFalso({ fatores: [{ id: "f1", status: "verified" }] });
    vi.mocked(createAdminClient).mockReturnValue(falso.admin as unknown as ReturnType<typeof createAdminClient>);
    comSupabase({
      verifyOtp: { data: { user: CONTA_PENDENTE, session: { access_token: "jwt" } }, error: null },
      getUser: { data: { user: null } },
    });

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=recovery&token_hash=abc"));

    expect(destino(res)).toBe("/login?error=conta_protegida");
    expect(falso.chamadas).toEqual(["senha", "fatores", "carimbo"]);
  });

  it("recuperação em conta JÁ verificada: não toca em senha, fatores nem sessões", async () => {
    const falso = gotrueFalso();
    vi.mocked(createAdminClient).mockReturnValue(falso.admin as unknown as ReturnType<typeof createAdminClient>);
    comSupabase({
      verifyOtp: { data: { user: USUARIO, session: { access_token: "jwt" } }, error: null },
      getUser: { data: { user: null } },
    });

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=recovery&token_hash=abc"));

    expect(falso.chamadas).toEqual([]);
    expect(destino(res)).toBe("/login/reset");
  });

  it("recuperação cujo link falhou mas há sessão antiga (segundo clique): NÃO reassume a conta", async () => {
    // Uma sessão que já existia não prova posse do endereço: o atacante logado não pode carimbar a própria conta.
    const falso = gotrueFalso();
    vi.mocked(createAdminClient).mockReturnValue(falso.admin as unknown as ReturnType<typeof createAdminClient>);
    comSupabase({
      verifyOtp: { data: { user: null }, error: { message: "Email link is invalid or has expired" } },
      getUser: { data: { user: CONTA_PENDENTE } },
    });

    const { GET } = await import("./route");
    await GET(requisicao("type=recovery&token_hash=gasto"));

    expect(falso.chamadas).toEqual([]);
  });

  it.each(["senha", "fatores", "sessoes", "gravacao"] as const)(
    "recuperação, falha na etapa %s: FALHA FECHADA, encerra a sessão e pede outro link",
    async (etapa) => {
      const falso = gotrueFalso({ falharEm: etapa });
      vi.mocked(createAdminClient).mockReturnValue(falso.admin as unknown as ReturnType<typeof createAdminClient>);
      comSupabase({
        verifyOtp: { data: { user: CONTA_PENDENTE, session: { access_token: "jwt" } }, error: null },
        getUser: { data: { user: null } },
      });

      const { GET } = await import("./route");
      const res = await GET(requisicao("type=recovery&token_hash=abc"));
      const cliente = await vi.mocked(createClient).mock.results.at(-1)!.value;

      expect(destino(res)).toBe("/login?error=link_invalido");
      expect(cliente.auth.signOut).toHaveBeenCalled();
      expect(falso.estado.app_metadata.email_verificado_em).toBeUndefined();
    },
  );
});
