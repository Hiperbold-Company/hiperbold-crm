/**
 * ONDA 2 DO REDESIGN — a marca das páginas de sistema tem TETO de tempo.
 *
 * Com a chave ligada, 403/404/500 e o convite leem a marca da instalação no
 * banco (`marcaDaSaida`). Essas páginas existem justamente para quando algo
 * deu errado: se o banco pendurar, a página de erro não pode pendurar junto.
 * Passado o teto, vale a marca do ambiente (APP_NAME/APP_LOGO_URL) ou o
 * padrão do produto. A 503 (manutenção, banco possivelmente fora) nem
 * consulta o banco.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  marca: (() => new Promise(() => {})) as () => Promise<unknown>,
  chamadas: 0,
}));

vi.mock("@/lib/redesign/chave", () => ({ redesignNaRequisicao: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: () => {
    h.chamadas += 1;
    return h.marca();
  },
}));

import ForbiddenPage from "@/app/403/page";
import InternalErrorPage from "@/app/500/page";
import ServiceUnavailablePage from "@/app/503/page";
import NotFound from "@/app/not-found";
import { TETO_DA_MARCA_MS, marcaDoAmbiente, marcaDoSistemaComTeto } from "@/lib/redesign/marca-do-sistema";

beforeEach(() => {
  vi.useFakeTimers();
  h.marca = () => new Promise(() => {});
  h.chamadas = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("marcaDoSistemaComTeto", () => {
  it("banco responde dentro do teto: vale a marca do banco", async () => {
    h.marca = async () => ({ nome: "Marca do Banco", logoUrl: "https://x.test/l.png", accent: "#123456" });
    const marca = await marcaDoSistemaComTeto();
    expect(marca).toMatchObject({ nome: "Marca do Banco", logoUrl: "https://x.test/l.png" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("banco nunca responde: passado o teto, vale a marca do ambiente", async () => {
    const p = marcaDoSistemaComTeto();
    await vi.advanceTimersByTimeAsync(TETO_DA_MARCA_MS);
    expect(await p).toEqual(marcaDoAmbiente());
  });

  it("leitura lança: vale a marca do ambiente, sem esperar o teto", async () => {
    h.marca = async () => {
      throw new Error("banco fora");
    };
    expect(await marcaDoSistemaComTeto()).toEqual(marcaDoAmbiente());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("o teto é curto (página de erro não pode esperar o banco)", () => {
    expect(TETO_DA_MARCA_MS).toBeLessThanOrEqual(2000);
  });

  it("a marca do ambiente sempre tem nome", () => {
    expect(marcaDoAmbiente().nome.trim()).not.toBe("");
  });
});

describe("páginas de sistema com o banco pendurado", () => {
  it.each([
    ["403", ForbiddenPage],
    ["404", NotFound],
    ["500", InternalErrorPage],
  ] as const)("%s renderiza dentro do teto, com a marca do ambiente", async (_codigo, Pagina) => {
    let pronta = false;
    const p = Pagina().then((el) => {
      pronta = true;
      return el;
    });
    await vi.advanceTimersByTimeAsync(TETO_DA_MARCA_MS);
    expect(pronta).toBe(true);
    const { container } = render(await p);
    expect(container.querySelector('[data-rd-sistema="rodape"]')?.textContent).toBe(marcaDoAmbiente().nome);
  });

  it("503 nem consulta o banco: renderiza na hora, com a marca do ambiente", async () => {
    const { container } = render(await ServiceUnavailablePage());
    expect(h.chamadas).toBe(0);
    expect(container.querySelector('[data-rd-sistema="rodape"]')?.textContent).toBe(marcaDoAmbiente().nome);
  });
});
