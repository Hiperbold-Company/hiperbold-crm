// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 429 DO GoTrue NÃO DESLOGA, E O PROXY NÃO PERGUNTA A CADA GET.
 *
 * Medido em produção (11/11/2026): rajadas de `/auth/v1/user` levaram o GoTrue
 * a responder 429 `over_request_rate_limit`, e o app lia o 429 como "deslogado"
 * — login ou 401 para quem estava com a sessão válida. O proxy chamava
 * `getUser()` em toda requisição não pública, sem cache.
 *
 * O Supabase é substituído só na borda (a resposta do GoTrue); o código que
 * decide — `getUserResiliente`, o cache curto, o `proxy`, o `loadAuthUser` — é
 * o de verdade.
 */

type Resposta = {
  data: { user: unknown };
  error: { name?: string; message: string; status?: number; code?: string } | null;
};

const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "a@b.c", user_metadata: {}, app_metadata: {} };
const LIMITE: Resposta = {
  data: { user: null },
  error: { name: "AuthApiError", message: "Request rate limit reached", status: 429, code: "over_request_rate_limit" },
};
const JWT_INVALIDO: Resposta = {
  data: { user: null },
  error: { name: "AuthApiError", message: "invalid JWT", status: 403, code: "bad_jwt" },
};
const SEM_SESSAO: Resposta = {
  data: { user: null },
  error: { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400 },
};
const OK: Resposta = { data: { user: USUARIO }, error: null };

/** O adaptador de cookies que o `@supabase/ssr` recebe — é por ele que o auth-js lê e apaga a sessão. */
type Adaptador = {
  getAll: () => { name: string; value: string }[];
  setAll: (c: { name: string; value: string; options: Record<string, unknown> }[]) => void;
};
/** Uma resposta pronta, ou o comportamento do auth-js diante dos cookies daquela tentativa. */
type Passo = Resposta | ((cookies: Adaptador | undefined) => Resposta);

const fila: { respostas: Passo[]; chamadas: number } = { respostas: [], chamadas: 0 };

function proximaResposta(cookies?: Adaptador): Promise<Resposta> {
  const r = fila.respostas[Math.min(fila.chamadas, fila.respostas.length - 1)]!;
  fila.chamadas += 1;
  return Promise.resolve(typeof r === "function" ? r(cookies) : r);
}

function consulta() {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data: null, error: null });
  c.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return c;
}

function clienteFalso(cookies?: Adaptador) {
  return {
    auth: { getUser: () => proximaResposta(cookies) },
    from: () => consulta(),
    rpc: async () => ({ data: null, error: null }),
  };
}

const logs: { msg: string; ctx?: Record<string, unknown> }[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    error: (msg: string, ctx?: Record<string, unknown>) => void logs.push({ msg, ctx }),
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
}));
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "http://supabase.local",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    IMPERSONATE_COOKIE_SECRET: "x".repeat(32),
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteFalso() }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _chave: string, opcoes: { cookies: Adaptador }) =>
    clienteFalso(opcoes.cookies),
}));

const { getUserResiliente, ehFalhaTransitoria, ESPERA_DO_LIMITE_MS } = await import(
  "@/lib/auth/get-user-resiliente"
);
const { esquecerTudo, invalidarUsuario, comCacheCurto, espiarCacheCurto, etiquetaDeUsuario, sessaoDosCookies } =
  await import("@/lib/auth/cache-curto");
const { removerTodosOsFatores } = await import("@/lib/auth/fatores-mfa-admin");
const { loadAuthUser } = await import("@/lib/auth/server");
const { proxy } = await import("@/proxy");
const { NextRequest } = await import("next/server");

/** Cookie de sessão no formato do `@supabase/ssr`, com o `exp` pedido. */
function cookieDeSessao(expSegundos: number, marca = "a"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "HS256" })}.${b64({ sub: USUARIO.id, exp: expSegundos })}.assinatura-${marca}`;
  return `sb-deskcomm-auth=base64-${b64({ access_token: jwt, refresh_token: `r-${marca}` })}`;
}

const daquiA = (s: number) => Math.floor(Date.now() / 1000) + s;

const pedir = (caminho: string, cookie: string) =>
  proxy(new NextRequest(`http://localhost:3000${caminho}`, { headers: { cookie } }));

beforeEach(() => {
  fila.respostas = [];
  fila.chamadas = 0;
  logs.length = 0;
  esquecerTudo();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getUserResiliente — 429 é transitório, com UMA nova tentativa", () => {
  it("classifica 429 e `over_request_rate_limit` como transitórios", () => {
    expect(ehFalhaTransitoria({ name: "AuthApiError", status: 429 })).toBe(true);
    expect(ehFalhaTransitoria({ name: "AuthApiError", code: "over_request_rate_limit" })).toBe(true);
    // Os definitivos de antes continuam definitivos.
    expect(ehFalhaTransitoria({ name: "AuthApiError", status: 403, code: "bad_jwt" })).toBe(false);
  });

  it("429 que passa na nova tentativa vira autenticado, com espera curta", async () => {
    fila.respostas = [LIMITE, OK];
    const esperas: number[] = [];
    const { resultado } = await getUserResiliente(async () => clienteFalso(), {
      esperar: async (ms) => void esperas.push(ms),
    });
    expect(resultado.estado).toBe("autenticado");
    expect(esperas).toEqual([ESPERA_DO_LIMITE_MS]);
    expect(ESPERA_DO_LIMITE_MS).toBeLessThanOrEqual(500);
  });

  it("429 persistente: duas chamadas só, e vira INDISPONÍVEL — não deslogado", async () => {
    fila.respostas = [LIMITE];
    const esperas: number[] = [];
    const { resultado } = await getUserResiliente(async () => clienteFalso(), {
      esperar: async (ms) => void esperas.push(ms),
    });
    expect(resultado.estado).toBe("indisponivel");
    expect(fila.chamadas).toBe(2);
    expect(esperas).toEqual([ESPERA_DO_LIMITE_MS]);
  });

  it("429 LANÇADO como exceção também é transitório", async () => {
    const { resultado } = await getUserResiliente(
      async () => ({
        auth: {
          getUser: async (): Promise<Resposta> => {
            throw Object.assign(new Error("Too Many Requests"), { status: 429 });
          },
        },
      }),
      { esperar: async () => {} },
    );
    expect(resultado.estado).toBe("indisponivel");
  });

  it("loadAuthUser com 429 persistente LANÇA auth_unavailable em vez de devolver null (login)", async () => {
    fila.respostas = [LIMITE];
    await expect(loadAuthUser()).rejects.toThrow(/auth_unavailable/);
    expect(fila.chamadas).toBe(2);
  });
});

describe("proxy — 429 responde 'tente de novo' e fica no log", () => {
  it("429 persistente numa API responde 503, não 401, e registra o erro sem o cookie", async () => {
    fila.respostas = [LIMITE];
    const cookie = "sb-deskcomm-auth=ilegivel";
    const r = await pedir("/api/v1/system/version", cookie);
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("unavailable");
    const linha = logs.find((l) => l.msg === "[proxy] getUser falhou");
    expect(linha?.ctx).toMatchObject({ estado: "indisponivel", status: 429, code: "over_request_rate_limit" });
    expect(JSON.stringify(linha)).not.toContain("ilegivel");
  });

  it("429 persistente numa tela não manda ao /login", async () => {
    fila.respostas = [LIMITE];
    const r = await pedir("/app/inbox", "sb-deskcomm-auth=ilegivel");
    expect(r.status).toBe(503);
    expect(r.headers.get("location")).toBeNull();
  });

  it("sessão ausente (visitante comum) NÃO entra no log", async () => {
    fila.respostas = [SEM_SESSAO];
    const r = await pedir("/app/inbox", "outro=1");
    expect(r.status).toBe(307);
    expect(logs.filter((l) => l.msg === "[proxy] getUser falhou")).toEqual([]);
  });

  it("JWT inválido continua indo ao /login, e entra no log", async () => {
    fila.respostas = [JWT_INVALIDO];
    const r = await pedir("/app/inbox", "sb-deskcomm-auth=ilegivel");
    expect(r.status).toBe(307);
    expect(logs.some((l) => l.msg === "[proxy] getUser falhou" && l.ctx?.status === 403)).toBe(true);
  });
});

describe("proxy — cache curto do getUser", () => {

  it("mesma sessão: o segundo GET não vai ao GoTrue", async () => {
    fila.respostas = [OK];
    const cookie = cookieDeSessao(daquiA(3600));
    expect((await pedir("/app/inbox", cookie)).status).toBe(200);
    expect((await pedir("/api/v1/system/version", cookie)).status).toBe(200);
    expect(fila.chamadas).toBe(1);
  });

  it("cookie diferente gera chave diferente: pergunta de novo", async () => {
    fila.respostas = [OK];
    const exp = daquiA(3600);
    await pedir("/app/inbox", cookieDeSessao(exp, "a"));
    await pedir("/app/inbox", cookieDeSessao(exp, "b"));
    expect(fila.chamadas).toBe(2);
  });

  it("a entrada nunca entra nos 90 s antes do `exp` (é ali que o auth-js renova o token)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    fila.respostas = [OK];
    const cookie = cookieDeSessao(daquiA(100)); // vale em cache até 10 s daqui
    await pedir("/app/inbox", cookie);
    vi.setSystemTime(new Date("2026-11-11T12:00:05Z"));
    await pedir("/app/inbox", cookie);
    expect(fila.chamadas).toBe(1); // antes da janela de renovação: acerto
    vi.setSystemTime(new Date("2026-11-11T12:00:11Z")); // a 89 s do `exp`
    await pedir("/app/inbox", cookie);
    expect(fila.chamadas).toBe(2);
  });

  it("token a menos de 90 s do `exp` não é cacheado: o proxy renova", async () => {
    fila.respostas = [OK];
    const cookie = cookieDeSessao(daquiA(80));
    await pedir("/app/inbox", cookie);
    await pedir("/app/inbox", cookie);
    expect(fila.chamadas).toBe(2);
  });

  it("token já vencido não é cacheado", async () => {
    fila.respostas = [OK];
    const cookie = cookieDeSessao(daquiA(-10));
    await pedir("/app/inbox", cookie);
    await pedir("/app/inbox", cookie);
    expect(fila.chamadas).toBe(2);
  });

  it("falha não é cacheada: 429 agora, sucesso na próxima requisição", async () => {
    fila.respostas = [LIMITE, LIMITE, OK];
    const cookie = cookieDeSessao(daquiA(3600));
    expect((await pedir("/app/inbox", cookie)).status).toBe(503);
    expect((await pedir("/app/inbox", cookie)).status).toBe(200);
    expect(fila.chamadas).toBe(3);
  });

  it("invalidarUsuario (sair, revogar) derruba a entrada do proxy", async () => {
    fila.respostas = [OK];
    const cookie = cookieDeSessao(daquiA(3600));
    await pedir("/app/inbox", cookie);
    invalidarUsuario(USUARIO.id);
    fila.respostas = [JWT_INVALIDO];
    fila.chamadas = 0;
    expect((await pedir("/app/inbox", cookie)).status).toBe(307);
    expect(fila.chamadas).toBe(1);
  });
});

describe("proxy — 429 no REFRESH não apaga a sessão", () => {
  /** O que o auth-js faz quando o refresh em `/token` leva 429: `_removeSession` e devolve o erro. */
  const refreshCom429 = (c: Adaptador | undefined): Resposta => {
    const temSessao = c?.getAll().some((x) => x.name === "sb-deskcomm-auth" && x.value !== "");
    if (!temSessao) return SEM_SESSAO;
    c!.setAll([{ name: "sb-deskcomm-auth", value: "", options: { maxAge: 0, path: "/" } }]);
    return LIMITE;
  };

  it("429 persistente no refresh: 503, o cookie de sessão NÃO é apagado, e fica no log", async () => {
    fila.respostas = [refreshCom429];
    const r = await pedir("/app/inbox", cookieDeSessao(daquiA(-30)));
    expect(r.status).toBe(503);
    expect(r.headers.get("location")).toBeNull();
    // A nova tentativa leu o cookie restaurado (sem o conserto ela via SEM_SESSAO e ia ao /login).
    expect(fila.chamadas).toBe(2);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toMatch(/sb-deskcomm-auth=(;|$)/);
    expect(setCookie).not.toMatch(/Max-Age=0/i);
    expect(logs.some((l) => l.msg.startsWith("[proxy] refresh falhou de forma transitória"))).toBe(true);
  });

  it("429 no refresh e sucesso na nova tentativa: segue, sem apagar cookie", async () => {
    fila.respostas = [refreshCom429, OK];
    const r = await pedir("/app/inbox", cookieDeSessao(daquiA(-30)));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie") ?? "").not.toMatch(/sb-deskcomm-auth=(;|$)/);
  });

  it("recusa DEFINITIVA do refresh continua sendo deslogado, sem nova tentativa nem restauração", async () => {
    fila.respostas = [
      (c) => {
        c!.setAll([{ name: "sb-deskcomm-auth", value: "", options: { maxAge: 0, path: "/" } }]);
        return {
          data: { user: null },
          error: { name: "AuthApiError", message: "Invalid Refresh Token", status: 400, code: "refresh_token_not_found" },
        };
      },
    ];
    const r = await pedir("/app/inbox", cookieDeSessao(daquiA(-30)));
    expect(r.status).toBe(307);
    expect(fila.chamadas).toBe(1);
    expect(logs.some((l) => l.msg.startsWith("[proxy] refresh falhou de forma transitória"))).toBe(false);
  });
});

describe("chave do cache e recusa curta", () => {
  it("só `sb-deskcomm-auth` e os pedaços `.N` entram na chave: cookie inventado não fura o cache", async () => {
    fila.respostas = [OK];
    const sessao = cookieDeSessao(daquiA(3600));
    await pedir("/app/inbox", `${sessao}; sb-x-auth=aleatorio1`);
    await pedir("/app/inbox", `${sessao}; sb-x-auth=aleatorio2; sb-deskcomm-auth-code-verifier=v`);
    expect(fila.chamadas).toBe(1);
    expect(sessaoDosCookies([{ name: "sb-outro-auth-token", value: "x" }])).toBeNull();
  });

  it("token recusado não vai ao GoTrue de novo por 5 s, e o login seguinte (cookie novo) não esbarra", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    const exp = daquiA(3600);
    fila.respostas = [JWT_INVALIDO];
    const velho = cookieDeSessao(exp, "velho");
    expect((await pedir("/app/inbox", velho)).status).toBe(307);
    expect((await pedir("/app/inbox", velho)).status).toBe(307);
    expect(fila.chamadas).toBe(1);
    // Login logo depois: cookie novo, chave nova — vai ao GoTrue e entra.
    fila.respostas = [OK];
    fila.chamadas = 0;
    expect((await pedir("/app/inbox", cookieDeSessao(exp, "novo"))).status).toBe(200);
    expect(fila.chamadas).toBe(1);
    // Passados 5 s, o token velho volta a ser perguntado.
    vi.setSystemTime(new Date("2026-11-11T12:00:06Z"));
    fila.respostas = [JWT_INVALIDO];
    fila.chamadas = 0;
    await pedir("/app/inbox", velho);
    expect(fila.chamadas).toBe(1);
  });
});

describe("remover os fatores de MFA derruba o cache curto da pessoa", () => {
  it("depois de remover, a sessão em cache não é mais servida", async () => {
    await comCacheCurto({
      chave: "sessao:de-u9",
      etiquetas: [etiquetaDeUsuario("u9")],
      carregar: async () => ({ estado: "autenticado" }),
    });
    const admin = {
      auth: {
        admin: {
          mfa: {
            listFactors: async () => ({ data: { factors: [{ id: "f1", status: "verified" }] }, error: null }),
            deleteFactor: async () => ({ data: null, error: null }),
          },
        },
      },
    };
    const r = await removerTodosOsFatores(admin as never, "u9");
    expect(r).toEqual({ ok: true, removidos: 1, verificadosRemovidos: 1 });
    expect(espiarCacheCurto("sessao:de-u9")).toBeUndefined();
  });
});
