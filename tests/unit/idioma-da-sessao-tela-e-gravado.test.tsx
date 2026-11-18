import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * QUEM TEM ESPANHOL GRAVADO VÊ A TELA EM PORTUGUÊS — E A SAÍDA SEGUE EM ESPANHOL.
 *
 * Espanhol e inglês saíram do seletor em 17/11/2026. `AuthUser.idioma` passou a
 * ser o idioma da TELA (`idiomaDaTela`), e `AuthUser.idiomaGravado` guarda o de
 * antes para quem escreve para fora da tela. Antes disto, as páginas de servidor
 * traduziam com o gravado e a tela saía metade em cada língua.
 *
 * O `loadAuthUser` é o real; só o GoTrue e o PostgREST são dublês.
 */

const USUARIO = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "a@b.c",
  user_metadata: { locale: "es" },
  app_metadata: {},
};

function consulta() {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "in", "limit"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data: null, error: null });
  c.single = async () => ({ data: null, error: null });
  c.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return c;
}
function clienteFalso() {
  return {
    auth: { getUser: async () => ({ data: { user: USUARIO }, error: null }) },
    from: () => consulta(),
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (para: string) => {
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

const { loadAuthUser } = await import("@/lib/auth/server");
const { traduzir } = await import("@/lib/i18n/dicionario");
const { roteiroPadrao } = await import("@/lib/cold-call/regras");

describe("a sessão de quem tem espanhol gravado", () => {
  it("idioma é o da tela (pt-BR); idiomaGravado segue es", async () => {
    const user = await loadAuthUser();
    expect(user?.idioma).toBe("pt-BR");
    expect(user?.idiomaGravado).toBe("es");
  });

  it("uma página de servidor que traduz com user.idioma sai em português", async () => {
    const user = (await loadAuthUser())!;
    // O mesmo que `app/support-ended/page.tsx`, `app/app/settings/profile/page.tsx`
    // e as demais fazem: `traduzir(texto, user.idioma)` no servidor.
    function Pagina() {
      return <h1>{traduzir("Contatos", user.idioma)}</h1>;
    }
    render(<Pagina />);
    expect(screen.getByRole("heading").textContent).toBe("Contatos");
    // Controle: o dicionário tem espanhol para a frase; com o gravado a página sairia em espanhol.
    expect(traduzir("Contatos", user.idiomaGravado!)).toBe("Contactos");
  });

  it("a saída para fora segue em espanhol: o roteiro padrão do cold call nasce no gravado", async () => {
    const user = (await loadAuthUser())!;
    expect(roteiroPadrao(user.idiomaGravado!)).toEqual(roteiroPadrao("es"));
    expect(roteiroPadrao(user.idiomaGravado!)).not.toEqual(roteiroPadrao("pt-BR"));
    // E as rotas que gravam para fora leem o campo gravado, não o da tela.
    for (const [arquivo, trecho] of [
      ["app/api/v1/cold-call/route.ts", "roteiroPadrao(authz.user.idiomaGravado ?? authz.user.idioma)"],
      ["app/api/v1/channel-sessions/disabled/route.ts", "idioma: auth.user.idiomaGravado ?? auth.user.idioma"],
      ["app/api/v1/channel-sessions/[id]/disabled/route.ts", "idioma: auth.user.idiomaGravado ?? auth.user.idioma"],
      ["app/api/v1/channel-sessions/[id]/route.ts", "idioma: user.idiomaGravado ?? user.idioma"],
    ] as const) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toContain(trecho);
    }
  });
});

describe("a empresa nova nasce pelo idioma do VISITANTE, não pelo da tela", () => {
  it("navegador em espanhol do México, tela cortada para pt-BR: a empresa nasce em es, MXN e fuso do México", async () => {
    const { idiomaDoCadastro } = await import("@/lib/i18n/idiomas");
    const { perfilDaEmpresaNova } = await import("@/lib/auth/perfil-da-empresa-nova");
    // A pista que `SignupForm`/`EntrarComGoogle` mandam: a tela está no padrão
    // (espanhol fora do seletor), então vale o navegador.
    const pista = idiomaDoCadastro("pt-BR", ["es-MX", "es"]);
    expect(pista).toBe("es");
    expect(
      perfilDaEmpresaNova({ idioma: pista, fuso: "America/Mexico_City", acceptLanguage: "es-MX,es;q=0.9" }),
    ).toMatchObject({ locale: "es", timezone: "America/Mexico_City", currency: "MXN" });
    // Controle: quem lê em português pelo navegador continua nascendo em pt-BR.
    expect(idiomaDoCadastro("pt-BR", ["pt-BR", "pt"])).toBe("pt-BR");
    for (const arquivo of ["components/auth/SignupForm.tsx", "components/auth/EntrarComGoogle.tsx"]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toContain("idiomaDoCadastro(idioma, navigator.languages)");
    }
  });
});
