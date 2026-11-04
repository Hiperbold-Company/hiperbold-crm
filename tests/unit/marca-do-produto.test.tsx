import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Sidebar } from "@/components/shell/Sidebar";
import { CLASSES_DO_LOGOTIPO, LogotipoDoProduto, SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { DEFAULT_APP_NAME, marcaEhADoProduto, type Branding } from "@/lib/branding";
import { MarcaDaInstalacaoProvider } from "@/lib/branding/contexto";
import { CORES_DA_MARCA, LOGOTIPO } from "@/lib/branding/desenho";

/**
 * A marca do PRODUTO aparece — e SÓ aparece — quando ninguém pôs a sua.
 *
 * O desenho vive em `lib/branding/desenho.ts` e a decisão em `marcaEhADoProduto`.
 * Este arquivo mede as duas metades: a regra pura, e a regra ALCANÇANDO a
 * barra lateral (conferir que a Sidebar importa o componente não bastaria — é
 * evidência de símbolo, não de comportamento).
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox", useRouter: () => ({ prefetch: vi.fn() }) }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
// O contador de casos lê a fila pelo React Query; aqui não há provider, e o
// número não é o objeto destes casos (o dele mora em contador-de-casos.test.tsx).
vi.mock("@/components/shell/ContadorDeCasos", () => ({ ContadorDeCasos: () => null }));
vi.mock("@/components/shell/ContadorDaFila", () => ({ ContadorDaFila: () => null }));
// O de tarefas lê a lista pelo React Query, e sem provider ele lança: o número
// dele mora em contador-de-tarefas.test.tsx.
vi.mock("@/components/shell/ContadorDeTarefas", () => ({ ContadorDeTarefas: () => null }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));

const usuario = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@exemplo.test",
  is_platform_admin: false,
  organizations: [],
} as unknown as AuthUser;
const org = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  name: "Loja da Ana",
  role: "admin",
} as ActiveOrg;
let contexto: { user: AuthUser; activeOrg: ActiveOrg | null } = { user: usuario, activeOrg: org };
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => contexto }));

const PADRAO: Branding = { name: DEFAULT_APP_NAME, logoUrl: null, initial: "H" };

function renderSidebar(marca: Branding, collapsed: boolean) {
  return render(
    <MarcaDaInstalacaoProvider marca={marca}>
      <Sidebar collapsed={collapsed} />
    </MarcaDaInstalacaoProvider>,
  );
}

afterEach(() => {
  cleanup();
  contexto = { user: usuario, activeOrg: org };
});

describe("marcaEhADoProduto", () => {
  it("é verdade só sem logo E com o nome padrão", () => {
    expect(marcaEhADoProduto(PADRAO)).toBe(true);
  });

  it("quem trocou o nome NÃO recebe um logotipo que soletra outro nome", () => {
    expect(marcaEhADoProduto({ name: "Acme CRM", logoUrl: null })).toBe(false);
  });

  it("quem subiu logo já tem o dele", () => {
    expect(marcaEhADoProduto({ name: DEFAULT_APP_NAME, logoUrl: "https://cdn.x/logo.png" })).toBe(
      false,
    );
  });
});

describe("o desenho na barra lateral", () => {
  it("aberta e sem marca própria, mostra o logotipo do produto (imagem de fundo, não <img>)", () => {
    renderSidebar(PADRAO, false);
    const logotipo = screen.getByRole("img", { name: DEFAULT_APP_NAME });
    expect(logotipo.tagName.toLowerCase()).toBe("span");
    expect(logotipo.className).toContain(LOGOTIPO.claro);
    expect(logotipo.className).toContain(LOGOTIPO.escuro);
    // O e2e `marca-logo.spec.ts` lê "barra sem <img>" como "sem logo do
    // revendedor"; um <img> do produto aqui faria a spec medir a coisa errada.
    expect(document.querySelector("img")).toBeNull();
    // Nem o nome em texto: o logotipo já o escreve.
    expect(screen.queryByText(DEFAULT_APP_NAME)).toBeNull();
  });

  it("recolhida, mostra só o símbolo — e não a inicial em texto", () => {
    renderSidebar(PADRAO, true);
    expect(screen.getByRole("img", { name: DEFAULT_APP_NAME }).tagName.toLowerCase()).toBe("svg");
    expect(screen.queryByText("H")).toBeNull();
  });

  it("com nome da instalação, segue em texto — o desenho do produto não vaza", () => {
    renderSidebar({ name: "Sistema do Revendedor", logoUrl: null, initial: "S" }, false);
    expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
    expect(document.querySelector("[role=img]")).toBeNull();
  });

  it("com nome da ORGANIZAÇÃO sobre a instalação padrão, o nome dela vence o desenho", () => {
    contexto = { user: usuario, activeOrg: { ...org, marca: { nome: "Loja da Ana" } } };
    renderSidebar(PADRAO, false);
    expect(screen.getByText("Loja da Ana")).toBeTruthy();
    expect(document.querySelector("[role=img]")).toBeNull();
  });

  it("com logo da instalação, a imagem vence o desenho", () => {
    renderSidebar({ ...PADRAO, logoUrl: "https://cdn.exemplo.test/logo.png" }, false);
    expect(screen.getByRole("img").tagName.toLowerCase()).toBe("img");
  });
});

describe("o logotipo e as cores do desenho", () => {
  it("as classes do componente apontam para os mesmos arquivos de LOGOTIPO, claro e escuro", () => {
    // O Tailwind só gera utilitário para URL LITERAL no fonte, então o
    // componente repete os caminhos. Isto é o que impede os dois de divergirem.
    expect(CLASSES_DO_LOGOTIPO).toContain(`bg-[url(${LOGOTIPO.claro})]`);
    expect(CLASSES_DO_LOGOTIPO).toContain(`dark:bg-[url(${LOGOTIPO.escuro})]`);
  });

  it("os dois arquivos do logotipo existem em public/", () => {
    for (const url of [LOGOTIPO.claro, LOGOTIPO.escuro]) {
      expect(fs.existsSync(path.join(process.cwd(), "public", url)), url).toBe(true);
    }
  });

  it("o símbolo desenha a marca branca sobre o ladrilho azul", () => {
    render(<SimboloDoProduto nome="Marca X" />);
    expect(document.querySelector("rect")?.getAttribute("fill")).toBe(CORES_DA_MARCA.ladrilho);
    expect(document.querySelector("path")?.getAttribute("fill")).toBe(CORES_DA_MARCA.marca);
  });

  it("decorativo esconde do leitor de tela; sem isso, nomeia a marca", () => {
    render(<SimboloDoProduto nome="Marca X" decorativo />);
    expect(document.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    cleanup();
    render(<LogotipoDoProduto nome="Marca X" decorativo />);
    expect(document.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
    cleanup();
    render(<LogotipoDoProduto nome="Marca X" />);
    expect(screen.getByRole("img", { name: "Marca X" })).toBeTruthy();
  });
});

describe("o favicon segue a mesma regra", () => {
  const icone = fs.readFileSync(path.join(process.cwd(), "app/icon.tsx"), "utf8");

  it("desenha o símbolo quando a marca é a do produto, e a inicial quando não é", () => {
    expect(icone).toMatch(/marcaEhADoProduto\(\{ name: marca\.nome, logoUrl: marca\.logoUrl \}\)/);
    expect(icone).toMatch(/<path d=\{SIMBOLO\.d\}/);
    expect(icone).toMatch(/letraDoIcone\(marca\.nome\)/);
  });
});

describe("o cabeçalho do onboarding segue a mesma regra do favicon", () => {
  const layout = fs.readFileSync(path.join(process.cwd(), "app/onboarding/layout.tsx"), "utf8");

  it("a marca padrão segue com o SVG que acompanha o tema, e o <img> só vale para marca própria", () => {
    // O `/icon` é um PNG sempre claro: desenhá-lo para a marca padrão punha um
    // ladrilho creme no tema escuro (PR #1942). A escolha passa pela MESMA regra
    // de `app/icon.tsx`, e o SVG vem antes do <img>.
    expect(layout).toMatch(
      /iconeUrl === ICONE_DESENHADO &&\s*marcaEhADoProduto\(\{ name: marcaDoIcone\.nome, logoUrl: marcaDoIcone\.logoUrl \}\)/,
    );
    expect(layout).toMatch(/simboloDoProduto \? \(\s*<SimboloDoProduto[^>]*decorativo/);
  });

  it("o ícone é decorativo: o nome já está escrito ao lado", () => {
    // Hiperbold: o cabeçalho tem antes um <img> do LOGO da instalação (marca
    // Hiperbold CRM), que ocupa o lugar do nome escrito; esse leva o nome no
    // alt. O ícone decorativo é o <img> do ramo sem logo, depois do símbolo.
    const inicioDoIcone = layout.indexOf("<img", layout.indexOf("simboloDoProduto ? ("));
    const img = layout.slice(inicioDoIcone, layout.indexOf("/>", inicioDoIcone));
    expect(img).toMatch(/alt=""/);
    const inicioDoLogo = layout.indexOf("<img");
    const logo = layout.slice(inicioDoLogo, layout.indexOf("/>", inicioDoLogo));
    expect(logo).toMatch(/data-testid="logo-do-onboarding"/);
    expect(logo).toMatch(/alt=\{marcaDoIcone\.nome\}/);
  });
});
