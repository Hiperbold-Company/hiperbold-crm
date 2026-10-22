// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUBLICAR O CRM NÃO PODE DESLOGAR NINGUÉM.
 *
 * Medido em produção (22/10/2026): depois de cada publicação, as sessões
 * seguiam válidas em `auth.sessions`, mas quem estava logado caía em `/login`.
 * Durante a troca de contêiner o `getUser()` falha por rede
 * (`AuthRetryableFetchError`), e `proxy.ts` e `app/app/layout.tsx` (via
 * `loadAuthUser`) liam `user: null` como "deslogado".
 *
 * Os casos medem o COMPORTAMENTO nas três portas reais — o proxy, o
 * `loadAuthUser` e a tela de login —, com o Supabase substituído só na borda
 * (a resposta do GoTrue), nunca o código que decide.
 */

type Resposta = {
  data: { user: unknown };
  error: { name?: string; message: string; status?: number; code?: string } | null;
};

const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "a@b.c", user_metadata: {}, app_metadata: {} };
const TRANSITORIO: Resposta = {
  data: { user: null },
  error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 },
};
const GATEWAY: Resposta = {
  data: { user: null },
  error: { name: "AuthRetryableFetchError", message: "Bad Gateway", status: 502 },
};
const JWT_INVALIDO: Resposta = {
  data: { user: null },
  error: { name: "AuthApiError", message: "invalid JWT", status: 403, code: "bad_jwt" },
};
const OK: Resposta = { data: { user: USUARIO }, error: null };

/** Fila de respostas do GoTrue, uma por chamada de `getUser`. */
const fila: { respostas: Resposta[]; chamadas: number; clientes: number } = {
  respostas: [],
  chamadas: 0,
  clientes: 0,
};

function proximaResposta(): Promise<Resposta> {
  const r = fila.respostas[Math.min(fila.chamadas, fila.respostas.length - 1)]!;
  fila.chamadas += 1;
  return Promise.resolve(r);
}

/** Cadeia do PostgREST: tudo devolve a si mesma; aguardar devolve lista vazia. */
function consulta() {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data: null, error: null });
  c.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return c;
}

function clienteFalso() {
  fila.clientes += 1;
  return {
    auth: { getUser: proximaResposta },
    from: () => consulta(),
    rpc: async () => ({ data: null, error: null }),
  };
}

const redirecionou: { para: string | null } = { para: null };

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (para: string) => {
    redirecionou.para = para;
    throw new Error(`NEXT_REDIRECT:${para}`);
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
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
vi.mock("@supabase/ssr", () => ({ createServerClient: () => clienteFalso() }));

const { getUserResiliente, ehFalhaTransitoria } = await import("@/lib/auth/get-user-resiliente");
const { loadAuthUser } = await import("@/lib/auth/server");
const { proxy } = await import("@/proxy");
const { destinoDoLoginComSessao } = await import("@/lib/auth/login-com-sessao");
const { default: LoginPage } = await import("@/app/(public)/login/page");
const { NextRequest } = await import("next/server");

beforeEach(() => {
  fila.respostas = [];
  fila.chamadas = 0;
  fila.clientes = 0;
  redirecionou.para = null;
});

describe("getUserResiliente — a regra, com as esperas medidas", () => {
  it("transitório que se recupera na 2ª tentativa vira autenticado", async () => {
    fila.respostas = [TRANSITORIO, OK];
    const esperas: number[] = [];
    const { resultado } = await getUserResiliente(async () => clienteFalso(), {
      esperar: async (ms) => void esperas.push(ms),
    });
    expect(resultado.estado).toBe("autenticado");
    expect(resultado.user).toBe(USUARIO);
    expect(fila.chamadas).toBe(2);
    expect(esperas).toEqual([300]);
  });

  it("transitório persistente: 3 tentativas, 1 s de espera somada, e vira INDISPONÍVEL — não deslogado", async () => {
    fila.respostas = [GATEWAY];
    const esperas: number[] = [];
    const { resultado } = await getUserResiliente(async () => clienteFalso(), {
      esperar: async (ms) => void esperas.push(ms),
    });
    expect(resultado.estado).toBe("indisponivel");
    expect(fila.chamadas).toBe(3);
    expect(esperas.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  });

  it("cada tentativa usa um cliente NOVO (o auth-js guarda a falha de refresh em cache)", async () => {
    fila.respostas = [TRANSITORIO, TRANSITORIO, OK];
    await getUserResiliente(async () => clienteFalso(), { esperar: async () => {} });
    expect(fila.clientes).toBe(3);
  });

  it("erro definitivo vira deslogado na 1ª tentativa, sem esperar", async () => {
    for (const definitivo of [
      JWT_INVALIDO,
      { data: { user: null }, error: { name: "AuthSessionMissingError", message: "x", status: 400 } },
      { data: { user: null }, error: { name: "AuthApiError", message: "x", status: 401 } },
      { data: { user: null }, error: { name: "AuthApiError", message: "User not found", status: 404, code: "user_not_found" } },
    ] satisfies Resposta[]) {
      fila.respostas = [definitivo];
      fila.chamadas = 0;
      const esperar = vi.fn(async () => {});
      const { resultado } = await getUserResiliente(async () => clienteFalso(), { esperar });
      expect(resultado.estado).toBe("deslogado");
      expect(fila.chamadas).toBe(1);
      expect(esperar).not.toHaveBeenCalled();
    }
  });

  it("exceção LANÇADA pelo getUser conta como transitória", async () => {
    let n = 0;
    const { resultado } = await getUserResiliente(
      async () => ({
        auth: {
          getUser: async (): Promise<Resposta> => {
            n += 1;
            if (n === 1) throw new TypeError("fetch failed");
            return OK;
          },
        },
      }),
      { esperar: async () => {} },
    );
    expect(resultado.estado).toBe("autenticado");
  });

  it("tentativa LENTA não dispara nova tentativa (o auth-js já repetiu por dentro)", async () => {
    fila.respostas = [TRANSITORIO, OK];
    let relogio = 0;
    const esperar = vi.fn(async () => {});
    const { resultado } = await getUserResiliente(
      async () => {
        const c = clienteFalso();
        return {
          ...c,
          auth: {
            getUser: async () => {
              relogio += 2500; // a biblioteca passou 2,5 s repetindo o /token
              return c.auth.getUser();
            },
          },
        };
      },
      { esperar, agora: () => relogio },
    );
    expect(resultado.estado).toBe("indisponivel");
    expect(fila.chamadas).toBe(1);
    expect(esperar).not.toHaveBeenCalled();
  });

  it("a próxima espera que estoura o orçamento total não começa", async () => {
    fila.respostas = [TRANSITORIO];
    let relogio = 0;
    const esperar = vi.fn(async (ms: number) => void (relogio += ms));
    const { resultado } = await getUserResiliente(
      async () => {
        const c = clienteFalso();
        return {
          ...c,
          auth: {
            getUser: async () => {
              relogio += 1500; // cada tentativa abaixo do limite, mas somadas estouram
              return c.auth.getUser();
            },
          },
        };
      },
      { esperar, agora: () => relogio },
    );
    expect(resultado.estado).toBe("indisponivel");
    // 1ª (1,5 s) + espera 300 + 2ª (1,5 s) = 3,3 s: a espera de 700 não cabe em 3 s.
    expect(fila.chamadas).toBe(2);
    expect(esperar.mock.calls).toEqual([[300]]);
  });

  it("AuthUnknownError (resposta sem JSON): 5xx/0 de origem é transitório; 4xx em HTML de proxy é definitivo, sem esperas", async () => {
    const semJson = (status?: number): Resposta => ({
      data: { user: null },
      error: Object.assign(
        { name: "AuthUnknownError", message: "Unexpected token <" },
        status === undefined ? {} : { originalError: { status } },
      ),
    });
    for (const s of [502, 503, 0]) {
      fila.respostas = [semJson(s), OK];
      fila.chamadas = 0;
      const { resultado } = await getUserResiliente(async () => clienteFalso(), { esperar: async () => {} });
      expect(resultado.estado, `status ${s}`).toBe("autenticado");
      expect(fila.chamadas).toBe(2);
    }
    // Sem status (o que o auth-js 2.117.2 entrega: originalError é o erro do JSON.parse)
    // e 4xx explícitos viram deslogado na 1ª chamada.
    for (const s of [400, 413, 431, undefined]) {
      fila.respostas = [semJson(s)];
      fila.chamadas = 0;
      const esperar = vi.fn(async () => {});
      const { resultado } = await getUserResiliente(async () => clienteFalso(), { esperar });
      expect(resultado.estado, `status ${s}`).toBe("deslogado");
      expect(fila.chamadas).toBe(1);
      expect(esperar).not.toHaveBeenCalled();
    }
  });

  it("exceção LANÇADA com status 4xx é definitiva; sem status ou 5xx, transitória", async () => {
    const lanca = (status?: number) => async () => ({
      auth: {
        getUser: async (): Promise<Resposta> => {
          throw Object.assign(new Error("x"), status === undefined ? {} : { status });
        },
      },
    });
    const sem = async () => {};
    expect((await getUserResiliente(lanca(401), { esperar: sem })).resultado.estado).toBe("deslogado");
    expect((await getUserResiliente(lanca(431), { esperar: sem })).resultado.estado).toBe("deslogado");
    expect((await getUserResiliente(lanca(503), { esperar: sem })).resultado.estado).toBe("indisponivel");
    expect((await getUserResiliente(lanca(), { esperar: sem })).resultado.estado).toBe("indisponivel");
  });

  it("classifica: rede e 5xx são transitórios; 4xx não", () => {
    expect(ehFalhaTransitoria({ name: "AuthRetryableFetchError", status: 0 })).toBe(true);
    expect(ehFalhaTransitoria({ name: "AuthApiError", status: 500 })).toBe(true);
    expect(ehFalhaTransitoria({ name: "AuthUnknownError", originalError: { status: 503 } })).toBe(true);
    expect(ehFalhaTransitoria({ name: "AuthUnknownError" })).toBe(false);
    expect(ehFalhaTransitoria({ name: "AuthUnknownError", originalError: { status: 413 } })).toBe(false);
    expect(ehFalhaTransitoria({ name: "AuthApiError", status: 401 })).toBe(false);
    expect(ehFalhaTransitoria({ name: "AuthApiError", status: 403 })).toBe(false);
    expect(ehFalhaTransitoria({ name: "AuthSessionMissingError", status: 400 })).toBe(false);
    expect(ehFalhaTransitoria(null)).toBe(false);
  });
});

describe("loadAuthUser — o gate de /app/*", () => {
  it("transitório que se recupera devolve o usuário (não manda ao login)", async () => {
    fila.respostas = [TRANSITORIO, OK];
    const user = await loadAuthUser();
    expect(user?.id).toBe(USUARIO.id);
  });

  it("transitório persistente LANÇA auth_unavailable — nunca devolve null (que viraria /login)", async () => {
    fila.respostas = [TRANSITORIO];
    await expect(loadAuthUser()).rejects.toThrow(/auth_unavailable/);
    expect(fila.chamadas).toBe(3);
  });

  it("erro definitivo devolve null (deslogado) depois de UMA chamada", async () => {
    fila.respostas = [JWT_INVALIDO];
    expect(await loadAuthUser()).toBeNull();
    expect(fila.chamadas).toBe(1);
  });
});

describe("proxy — a primeira porta de toda requisição", () => {
  const pedir = (caminho: string) =>
    proxy(
      new NextRequest(`http://localhost:3000${caminho}`, {
        headers: { cookie: "sb-deskcomm-auth=abc" },
      }),
    );

  it("transitório persistente numa tela responde 503 com a página /503 — sem redirect para /login", async () => {
    fila.respostas = [TRANSITORIO];
    const r = await pedir("/app/inbox");
    expect(r.status).toBe(503);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("x-middleware-rewrite")).toMatch(/\/503$/);
    expect(r.headers.get("retry-after")).toBe("5");
    // Nenhum cookie de sessão apagado.
    expect(r.headers.get("set-cookie") ?? "").not.toMatch(/sb-deskcomm-auth=;/);
  });

  it("transitório persistente numa API responde 503 no envelope de erro, não 401", async () => {
    fila.respostas = [GATEWAY];
    const r = await pedir("/api/v1/system/version");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({
      error: { code: "unavailable", message: expect.any(String) },
    });
  });

  it("transitório que se recupera deixa passar", async () => {
    fila.respostas = [TRANSITORIO, OK];
    const r = await pedir("/app/inbox");
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("erro definitivo continua mandando ao /login com o next", async () => {
    fila.respostas = [JWT_INVALIDO];
    const r = await pedir("/app/inbox?x=1");
    expect(r.status).toBe(307);
    const destino = new URL(r.headers.get("location")!);
    expect(destino.pathname).toBe("/login");
    expect(destino.searchParams.get("next")).toBe("/app/inbox?x=1");
    expect(fila.chamadas).toBe(1);
  });
});

describe("/login com sessão válida", () => {
  const abrir = (params: Record<string, string>) =>
    LoginPage({ searchParams: Promise.resolve(params) });

  it("redireciona para o `next` interno", async () => {
    fila.respostas = [OK];
    await expect(abrir({ next: "/app/inbox?id=7" })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirecionou.para).toBe("/app/inbox?id=7");
  });

  it("sem `next`, vai para /app", async () => {
    fila.respostas = [OK];
    await expect(abrir({})).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirecionou.para).toBe("/app");
  });

  it.each(["//evil.com", "https://evil.com/x", "/\\evil.com", "javascript:alert(1)"])(
    "recusa `next` externo (%s) e vai para /app",
    async (next) => {
      fila.respostas = [OK];
      await expect(abrir({ next })).rejects.toThrow(/NEXT_REDIRECT/);
      expect(redirecionou.para).toBe("/app");
    },
  );

  it("sem sessão, mostra o formulário (não redireciona)", () => {
    expect(destinoDoLoginComSessao({ logado: false, next: "/app" })).toBeNull();
  });

  it("com recado na tela (erro, senha redefinida, código usado), mostra o formulário", () => {
    expect(destinoDoLoginComSessao({ logado: true, error: "acesso_revogado" })).toBeNull();
    expect(destinoDoLoginComSessao({ logado: true, reset: "success" })).toBeNull();
    expect(destinoDoLoginComSessao({ logado: true, recovery_used: "1" })).toBeNull();
  });
});
