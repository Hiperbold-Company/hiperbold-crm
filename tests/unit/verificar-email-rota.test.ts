/**
 * GET /auth/verificar-email?token=: abre o link do e-mail, com teto por IP, e SEMPRE responde com um redirect
 * para a página de desfecho (que nunca vê o token).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";

import { isPublicPath } from "@/lib/auth/public-paths";
import { emailVerificado, emitirPedido } from "@/lib/auth/verificacao-email";

import { criarAuthAdminFalso } from "./helpers/auth-admin-falso";

const bordas = vi.hoisted(() => ({ admin: null as unknown, auditar: vi.fn(), sessao: null as { id: string } | null }));

vi.mock("next/headers", () => ({ headers: vi.fn() }));
// A sessão do navegador (cookie): `getUser()` valida no provedor. Cada caso escolhe quem está logado.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: bordas.sessao } }) } }),
}));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Central de Teste" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => bordas.admin }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: (...a: unknown[]) => bordas.auditar(...a),
}));

const USER = "11111111-1111-4111-8111-111111111111";
let ipN = 0;

function pedir(token?: string, ponte = false) {
  const url = new URL("http://localhost/auth/verificar-email");
  if (token !== undefined) url.searchParams.set("token", token);
  if (ponte) url.searchParams.set("p", "1");
  return new NextRequest(url, { headers: { "x-request-id": "req-9", "user-agent": "vitest" } });
}

function desfecho(res: Response): string {
  const destino = new URL(res.headers.get("location")!);
  expect(destino.pathname).toBe("/auth/verificar-email/resultado");
  return destino.searchParams.get("s")!;
}

beforeEach(() => {
  vi.resetModules();
  bordas.auditar.mockReset();
  // Por padrão a pessoa está logada na PRÓPRIA conta (o caso comum); os casos sem sessão a trocam.
  bordas.sessao = { id: USER };
  ipN += 1;
  vi.mocked(headers).mockResolvedValue({
    get: (k: string) => (k === "x-forwarded-for" ? `192.0.2.${ipN % 250}` : null),
  } as never);
});

describe("rota pública de verificação", () => {
  it("é pública só nos dois caminhos exatos (rota e página de desfecho)", () => {
    expect(isPublicPath("/auth/verificar-email")).toBe(true);
    expect(isPublicPath("/auth/verificar-email/resultado")).toBe(true);
    expect(isPublicPath("/auth/verificar-email/outra")).toBe(false);
    expect(isPublicPath("/auth/verificar-email/resultado/x")).toBe(false);
    expect(isPublicPath("/auth/verificar-emailx")).toBe(false);
  });

  it("token válido: verifica a conta, audita sem o token e leva ao desfecho 'ok'", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "dono@plata.test", app_metadata: {} }]);
    bordas.admin = f.cliente;
    const e = await emitirPedido({ admin: f.cliente, userId: USER });
    if (!e.ok) throw new Error("emissão falhou");

    const { GET } = await import("@/app/auth/verificar-email/route");
    const res = await GET(pedir(e.token));

    expect(res.status).toBe(307);
    expect(desfecho(res)).toBe("ok");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(emailVerificado(f.appMetadata(USER))).toBe(true);
    expect(bordas.auditar).toHaveBeenCalledTimes(1);
    const linha = bordas.auditar.mock.calls[0]![0] as Record<string, unknown>;
    expect(linha.action).toBe("auth.email_verified");
    expect(linha.actorUserId).toBe(USER);
    expect(JSON.stringify(linha)).not.toContain("plata.test");
    expect(JSON.stringify(linha)).not.toContain(e.token);
  });

  it("segunda abertura do mesmo link: 'invalido', sem auditar de novo", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "dono@plata.test", app_metadata: {} }]);
    bordas.admin = f.cliente;
    const e = await emitirPedido({ admin: f.cliente, userId: USER });
    if (!e.ok) throw new Error("emissão falhou");
    const { GET } = await import("@/app/auth/verificar-email/route");

    expect(desfecho(await GET(pedir(e.token)))).toBe("ok");
    expect(desfecho(await GET(pedir(e.token)))).toBe("invalido");
    expect(bordas.auditar).toHaveBeenCalledTimes(1);
  });

  it("link vencido: 'expirado'; lixo e ausência de token: 'invalido'; nenhuma escrita", async () => {
    const f = criarAuthAdminFalso([{ id: USER, email: "dono@plata.test", app_metadata: {} }]);
    bordas.admin = f.cliente;
    const e = await emitirPedido({ admin: f.cliente, userId: USER, agora: new Date(Date.now() - 8 * 86_400_000) });
    if (!e.ok) throw new Error("emissão falhou");
    const escritasAntes = f.escritas.length;
    const { GET } = await import("@/app/auth/verificar-email/route");

    expect(desfecho(await GET(pedir(e.token)))).toBe("expirado");
    expect(desfecho(await GET(pedir("lixo")))).toBe("invalido");
    expect(desfecho(await GET(pedir()))).toBe("invalido");
    expect(f.escritas.length).toBe(escritasAntes);
    expect(bordas.auditar).not.toHaveBeenCalled();
  });

  it("teto por IP: depois de 30 aberturas na hora o 31º recebe 'limite' sem consultar a conta", async () => {
    const f = criarAuthAdminFalso([]);
    const lerConta = vi.spyOn(f.bruto.auth.admin, "getUserById");
    bordas.admin = f.cliente;
    const { GET } = await import("@/app/auth/verificar-email/route");

    // Forma válida de token: cada tentativa consulta a conta (e não é recusada já na leitura da forma).
    const chute = `${USER}.${"A".repeat(43)}`;
    for (let i = 0; i < 30; i++) expect(desfecho(await GET(pedir(chute)))).toBe("invalido");
    expect(lerConta).toHaveBeenCalledTimes(30);
    expect(desfecho(await GET(pedir(chute)))).toBe("limite");
    expect(lerConta).toHaveBeenCalledTimes(30);
  });

  // ─── D-204: só carimba com a sessão da própria conta ────────────────────────────

  describe("exige a sessão da própria conta", () => {
    async function emitir() {
      const f = criarAuthAdminFalso([{ id: USER, email: "dono@plata.test", app_metadata: {} }]);
      bordas.admin = f.cliente;
      const e = await emitirPedido({ admin: f.cliente, userId: USER });
      if (!e.ok) throw new Error("emissão falhou");
      return { f, token: e.token };
    }

    it("sem sessão na primeira passada: devolve a PONTE (o cookie Strict não viaja do cliente de e-mail) e não consome", async () => {
      const { f, token } = await emitir();
      const { GET } = await import("@/app/auth/verificar-email/route");
      bordas.sessao = null;

      const res = await GET(pedir(token));

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("window.location.replace");
      expect(html).toContain("p=1");
      expect(emailVerificado(f.appMetadata(USER))).toBe(false);
      expect(bordas.auditar).not.toHaveBeenCalled();
    });

    it("sem sessão mesmo depois da ponte: manda ao login com o aviso, e o link CONTINUA valendo", async () => {
      const { f, token } = await emitir();
      const { GET } = await import("@/app/auth/verificar-email/route");
      bordas.sessao = null;

      const res = await GET(pedir(token, true));

      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe(
        "/login?error=verificar_email_entre",
      );
      expect(emailVerificado(f.appMetadata(USER))).toBe(false);
      // Depois de entrar, o MESMO link funciona.
      bordas.sessao = { id: USER };
      expect(desfecho(await GET(pedir(token)))).toBe("ok");
      expect(emailVerificado(f.appMetadata(USER))).toBe(true);
    });

    it("sessão de OUTRA conta: não consome nem carimba (quem tem só o link não verifica a conta de ninguém)", async () => {
      const { f, token } = await emitir();
      const { GET } = await import("@/app/auth/verificar-email/route");
      bordas.sessao = { id: "99999999-9999-4999-8999-999999999999" };

      const res = await GET(pedir(token));

      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("verificar_email_entre");
      expect(emailVerificado(f.appMetadata(USER))).toBe(false);
      expect(bordas.auditar).not.toHaveBeenCalled();
    });

    it("token de forma inválida não consulta sessão nem conta: segue 'invalido'", async () => {
      const { GET } = await import("@/app/auth/verificar-email/route");
      bordas.sessao = null;
      expect(desfecho(await GET(pedir("lixo")))).toBe("invalido");
    });
  });
});
