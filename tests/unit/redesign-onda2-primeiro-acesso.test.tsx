/**
 * ONDA 2 DO REDESIGN — o primeiro acesso (onboarding) no v49.
 *
 * Com a chave ligada, a casca do onboarding ganha o trilho "Seu primeiro
 * acesso" à esquerda (os passos REAIS de `lib/onboarding/passos.ts`, com o
 * cumprido marcado e o atual destacado), o "Passo N de M" no cabeçalho e a
 * barra de progresso. Nada de lista fixa do protótipo: os passos variam por
 * instalação.
 *
 * Fora, por exigirem função nova: "Fazer depois" (pular o passo vira
 * pendência no Início), os cartões de tipo de negócio e o rodapé fixo com
 * Voltar/Continuar (os botões moram dentro dos formulários de cada passo).
 *
 * Desligada, o HTML é o de sempre.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ligado: false, caminho: "/onboarding/funil" }));

vi.mock("@/lib/redesign/chave", () => ({ redesignNaRequisicao: async () => h.ligado }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
  usePathname: () => h.caminho,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u", idioma: "pt-BR", support: null, organizations: [] }),
  resolveActiveOrg: async () => ({ orgId: "org", name: "Clínica Teste" }),
  exigirProvaDeMfa: async () => {},
}));
vi.mock("@/app/actions/onboarding/_shared", () => ({
  loadOnboardingState: async () => ({ state: { welcome: true }, onboardedAt: null }),
}));
vi.mock("@/lib/onboarding/contexto", () => ({ contextoDoOnboarding: async () => ({}) }));
vi.mock("@/lib/onboarding/passos", () => ({
  passosVisiveis: () => [
    { segmento: "welcome", rotulo: "Boas-vindas", cumprido: (s: Record<string, boolean>) => !!s.welcome },
    { segmento: "funil", rotulo: "Seu funil", cumprido: () => false },
    { segmento: "connect-whatsapp", rotulo: "Conectar WhatsApp", cumprido: () => false },
    { segmento: "done", rotulo: "Pronto", cumprido: () => false },
  ],
}));
vi.mock("@/lib/onboarding/destino", () => ({ destinoSeJaConcluido: () => "/app" }));
vi.mock("@/lib/onboarding/precisa-pagar", () => ({ compraPeloClienteDisponivel: async () => false }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => null }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Marca Teste", logoUrl: null, accent: "#123456" }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/app/onboarding/_components/OutrasOrganizacoes", () => ({ OutrasOrganizacoes: () => null }));
vi.mock("@/app/onboarding/_components/SairDoOnboarding", () => ({ SairDoOnboarding: () => <button type="button">Sair</button> }));

import OnboardingLayout from "@/app/onboarding/layout";

async function casca() {
  return OnboardingLayout({ children: <p>conteúdo do passo</p> });
}

afterEach(() => {
  cleanup();
  h.ligado = false;
  h.caminho = "/onboarding/funil";
});

describe("onda 2 — primeiro acesso, chave DESLIGADA", () => {
  it("HTML idêntico ao de sempre", async () => {
    const html = renderToStaticMarkup(await casca());
    expect(html).toMatchSnapshot();
    expect(html).not.toContain("data-rd-entrar");
  });
});

describe("onda 2 — primeiro acesso, chave LIGADA", () => {
  it("trilho 'Seu primeiro acesso' com os passos reais, na ordem", async () => {
    h.ligado = true;
    const { container } = render(await casca());
    const trilho = container.querySelector('[data-rd-entrar="trilho"]') as HTMLElement;
    expect(trilho).not.toBeNull();
    expect(within(trilho).getByText("Seu primeiro acesso")).toBeTruthy();
    const itens = within(trilho).getAllByRole("listitem");
    expect(itens.map((i) => i.textContent)).toEqual(["Boas-vindas", "Seu funil", "Conectar WhatsApp", "Pronto"].map((r) => expect.stringContaining(r)));
    expect(itens[0]!.getAttribute("data-cumprido")).toBe("true");
    expect(itens[1]!.getAttribute("aria-current")).toBe("step");
    expect(itens[2]!.getAttribute("data-cumprido")).toBe("false");
  });

  it("cabeçalho diz 'Passo N de M' e a barra de progresso acompanha", async () => {
    h.ligado = true;
    render(await casca());
    expect(screen.getByText("Passo 2 de 4")).toBeTruthy();
    const barra = screen.getByRole("progressbar");
    expect(barra.getAttribute("aria-valuenow")).toBe("2");
    expect(barra.getAttribute("aria-valuemax")).toBe("4");
  });

  it("o conteúdo do passo continua dentro da casca, e a saída também", async () => {
    h.ligado = true;
    const { container } = render(await casca());
    expect(within(container.querySelector('[data-rd-entrar="conteudo"]') as HTMLElement).getByText("conteúdo do passo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sair" })).toBeTruthy();
    expect(container.querySelector('[data-rd-entrar="logo"]')?.textContent).toContain("Marca Teste");
  });

  it("fora de um passo conhecido, não inventa número", async () => {
    h.ligado = true;
    h.caminho = "/onboarding";
    render(await casca());
    expect(screen.queryByText(/^Passo \d+ de \d+$/)).toBeNull();
  });
});
