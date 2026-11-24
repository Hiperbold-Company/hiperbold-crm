/**
 * ONDA 2 DO REDESIGN — as páginas de sistema na família do v49.
 *
 * Com a chave ligada, 403, 404, 500 e 503 viram o cartão do protótipo: logo da
 * marca em cima, ícone redondo com o tom do erro, rótulo "Erro NNN", título,
 * duas linhas (o que aconteceu / o que fazer), ação principal, ação
 * secundária e o nome da marca no rodapé.
 *
 * Fica de FORA o que exigiria função nova (pedir acesso, relatar, busca,
 * previsão de volta, página de status): o v49 mostra, o produto ainda não tem.
 *
 * Desligada, a página é byte a byte a de sempre — provado pelo HTML inteiro,
 * não só pela ausência de atributo, porque a onda 2 acrescenta ELEMENTOS.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ligado: false, idioma: "pt-BR" as string }));

vi.mock("@/lib/redesign/chave", () => ({ redesignNaRequisicao: async () => h.ligado }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => h.idioma }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Marca Teste", logoUrl: null, accent: "#123456" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));

import ForbiddenPage from "@/app/403/page";
import InternalErrorPage from "@/app/500/page";
import ServiceUnavailablePage from "@/app/503/page";
import NotFound from "@/app/not-found";

afterEach(() => {
  cleanup();
  h.ligado = false;
  h.idioma = "pt-BR";
});

const PAGINAS = {
  "403": ForbiddenPage,
  "404": NotFound,
  "500": InternalErrorPage,
  "503": ServiceUnavailablePage,
} as const;

/** O que o v49 pede de cada página, só com o que o produto já tem. */
const ESPERADO: Record<keyof typeof PAGINAS, { tom: string; titulo: string; principal: RegExp; secundaria: RegExp }> = {
  "403": { tom: "aviso", titulo: "Você não tem acesso a esta tela", principal: /voltar ao início/i, secundaria: /voltar à página anterior/i },
  "404": { tom: "info", titulo: "Não achamos esta página", principal: /ir para o início/i, secundaria: /voltar à página anterior/i },
  "500": { tom: "erro", titulo: "Algo deu errado do nosso lado", principal: /tentar de novo/i, secundaria: /ir para o início/i },
  "503": { tom: "aviso", titulo: "Estamos em manutenção", principal: /atualizar a página/i, secundaria: /ir para o início/i },
};

async function html(codigo: keyof typeof PAGINAS) {
  return renderToStaticMarkup(await PAGINAS[codigo]());
}

describe("onda 2 — páginas de sistema, chave DESLIGADA", () => {
  it.each(Object.keys(PAGINAS) as Array<keyof typeof PAGINAS>)("%s: HTML idêntico ao de sempre", async (codigo) => {
    h.ligado = false;
    expect(await html(codigo)).toMatchSnapshot();
  });

  it.each(Object.keys(PAGINAS) as Array<keyof typeof PAGINAS>)("%s: nada da família nova aparece", async (codigo) => {
    h.ligado = false;
    const pagina = await html(codigo);
    expect(pagina).not.toContain("data-rd-sistema");
    expect(pagina).not.toContain("Marca Teste");
  });
});

describe("onda 2 — páginas de sistema, chave LIGADA", () => {
  it.each(Object.keys(PAGINAS) as Array<keyof typeof PAGINAS>)("%s: cartão do v49 completo", async (codigo) => {
    h.ligado = true;
    const e = ESPERADO[codigo];
    const { container } = render(await PAGINAS[codigo]());

    const icone = container.querySelector('[data-rd-sistema="icone"]');
    expect(icone?.getAttribute("data-tom")).toBe(e.tom);
    expect(icone?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-rd-sistema="rotulo"]')?.textContent).toBe(`Erro ${codigo}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(e.titulo);
    expect(container.querySelectorAll('[data-rd-sistema="texto"]').length).toBe(2);

    const acoes = container.querySelector('[data-rd-sistema="acoes"]') as HTMLElement;
    const controles = within(acoes).getAllByRole(/^(link|button)$/ as unknown as "link");
    expect(controles[0]!.textContent).toMatch(e.principal);
    expect(controles[1]!.textContent).toMatch(e.secundaria);
  });

  it("o nome no rodapé e o logo vêm do resolvedor da marca, nunca de texto fixo", async () => {
    h.ligado = true;
    const { container } = render(await ForbiddenPage());
    expect(container.querySelector('[data-rd-sistema="rodape"]')?.textContent).toBe("Marca Teste");
    expect(container.querySelector('[data-rd-sistema="logo"]')?.textContent).toContain("Marca Teste");
  });

  it("os links levam ao Início de verdade (/app/inicio)", async () => {
    h.ligado = true;
    render(await ForbiddenPage());
    expect(screen.getByRole("link", { name: /voltar ao início/i }).getAttribute("href")).toBe("/app/inicio");
  });

  it("nenhuma ação sem função: sem 'Pedir acesso', 'Relatar', busca nem 'Ver status'", async () => {
    h.ligado = true;
    for (const codigo of Object.keys(PAGINAS) as Array<keyof typeof PAGINAS>) {
      const pagina = await html(codigo);
      expect(pagina).not.toMatch(/Pedir acesso|Relatar|Ver status|type="search"/);
    }
  });

  it("em inglês, o cartão fala inglês", async () => {
    h.ligado = true;
    h.idioma = "en";
    render(await NotFound());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("We couldn't find this page");
    expect(screen.getByText("Error 404")).toBeTruthy();
  });
});

describe("onda 2 — idioma do documento nas páginas fora do /app", () => {
  it("404 em inglês entrega o idioma ao documento (IdiomaProvider)", async () => {
    h.idioma = "en";
    render(await NotFound());
    expect(document.documentElement.lang).toBe("en");
  });

  it("503 segue o idioma do visitante, sem depender do Supabase", async () => {
    h.idioma = "en";
    render(await ServiceUnavailablePage());
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("503 — Under maintenance");
  });
});
