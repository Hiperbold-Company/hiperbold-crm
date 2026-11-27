/**
 * PÁGINAS DE SISTEMA NO IDIOMA DO VISITANTE.
 *
 * 403, 500, /admin/forbidden e 404 podem ser abertas sem sessão. Elas liam só o
 * idioma da conta, e o visitante anônimo com o navegador em inglês via
 * português. Agora usam `idiomaDoVisitante`, como as telas públicas: o idioma da
 * conta quando há, senão o `Accept-Language`.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ aceita: "en-US,en;q=0.9", locale: null as string | null }));

vi.mock("@/lib/redesign/chave", () => ({ redesignNaRequisicao: async () => false }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: h.locale ? { email: "x@exemplo.com", user_metadata: { locale: h.locale } } : null },
      }),
    },
  }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "accept-language": h.aceita }),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
vi.mock("@/app/actions/auth/signOut", () => ({ signOut: vi.fn() }));

import Pagina403 from "@/app/403/page";
import Pagina500 from "@/app/500/page";
import PaginaForbidden from "@/app/admin/forbidden/page";
import Pagina404 from "@/app/not-found";

const PAGINAS = [
  ["403", Pagina403],
  ["500", Pagina500],
  ["admin/forbidden", PaginaForbidden],
  ["404", Pagina404],
] as const;

async function titulo(P: () => Promise<React.ReactElement>) {
  const { container } = render(await P());
  return container.querySelector("h1")?.textContent ?? "";
}

afterEach(() => {
  cleanup();
  h.aceita = "en-US,en;q=0.9";
  h.locale = null;
});

describe("páginas de sistema: idioma do visitante", () => {
  for (const [nome, P] of PAGINAS) {
    it(`${nome}: anônimo com navegador em inglês vê inglês, e em português vê português`, async () => {
      const en = await titulo(P as never);
      cleanup();
      h.aceita = "pt-BR,pt;q=0.9";
      const pt = await titulo(P as never);
      expect(en).not.toBe("");
      expect(pt).not.toBe("");
      expect(en).not.toBe(pt);
    });

    it(`${nome}: o idioma da conta vence o do navegador`, async () => {
      h.locale = "pt-BR";
      const conta = await titulo(P as never);
      cleanup();
      h.locale = null;
      h.aceita = "pt-BR";
      expect(conta).toBe(await titulo(P as never));
    });
  }
});
