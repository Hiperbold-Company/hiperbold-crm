/**
 * AS CONEXÕES NO REDESIGN — desligado é a tela de sempre, ligado é a nova.
 *
 * A tela não foi duplicada: os componentes de `components/connections` ganham
 * `data-rd-conexoes="<peça>"` SÓ com a chave ligada (`useMarcaDasConexoes`), e o
 * bloco "redesign: conexoes" de `app/globals.css` os desenha. Provado aqui:
 *
 *   1. DOM — sem o provedor do redesign nenhum atributo é escrito; com ele, as
 *      peças principais aparecem (barra, grade, cartão e suas partes).
 *   2. CSS — todo seletor do bloco começa por `[data-redesign="ligado"]`.
 *
 * NÃO prova a aparência: jsdom não pinta; a semelhança com o protótipo v49 só
 * se confere na tela.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import postcss from "postcss";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CartaoDaConexao } from "@/lib/channels/conexoes-em-cartoes";

const h = vi.hoisted(() => ({ conexoes: [] as unknown[] }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/app/connections",
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { is_platform_admin: false, support: null } }),
  usePermission: () => true,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (path: string) => (path === "/api/v1/channels/conexoes" ? { data: h.conexoes } : { data: {} })),
    post: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({})),
  },
}));

import { CartaoDeConexao } from "@/components/connections/CartaoDeConexao";
import { ConexoesShell } from "@/components/connections/ConexoesShell";
import { marcaDasConexoes } from "@/lib/redesign/conexoes";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

const CONEXAO: CartaoDaConexao = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "x",
  tipo: "whatsapp_qr",
  via: null,
  nome: "Suporte",
  numero_ou_handle: "+55 11 90000-0002",
  status: "desconectado",
  status_bruto: "SCAN_QR_CODE",
  pareamento: null,
  created_at: "2026-11-17T00:00:00Z",
  oficial: null,
};

function ligado({ children }: { children: ReactNode }) {
  return <ProvedorDoRedesign ligado>{children}</ProvedorDoRedesign>;
}

function tela() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ConexoesShell wahaConfigured={false} wacallsConfigured={false} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  h.conexoes = [];
});

describe("redesign: conexões, DOM", () => {
  it("desligado, o cartão não escreve nenhum data-rd-conexoes", () => {
    const { container } = render(<CartaoDeConexao conexao={CONEXAO} aoGerenciar={() => {}} />);
    expect(container.querySelectorAll("[data-rd-conexoes]")).toHaveLength(0);
  });

  it("desligado, a tela (barra, grade e cartões) não escreve nenhum data-rd-conexoes", async () => {
    h.conexoes = [CONEXAO];
    const { container } = render(tela());
    await screen.findByTestId("grade-de-conexoes");
    expect(container.querySelectorAll("[data-rd-conexoes]")).toHaveLength(0);
  });

  it("ligado, o cartão marca as peças e mantém os data-testid", () => {
    const { container } = render(<CartaoDeConexao conexao={CONEXAO} aoGerenciar={() => {}} />, { wrapper: ligado });
    const pecas = Array.from(container.querySelectorAll("[data-rd-conexoes]")).map((e) => e.getAttribute("data-rd-conexoes"));
    for (const p of ["cartao", "cartao-topo", "status", "icone", "tipo", "nome", "numero", "rodape", "gerenciar"]) {
      expect(pecas).toContain(p);
    }
    expect(screen.getByTestId("nome-da-conexao").textContent).toBe("Suporte");
    expect(screen.getByTestId(`gerenciar-${CONEXAO.id}`)).toBeTruthy();
  });

  it("ligado, a tela marca a barra, a busca, o contador, o Criar e a grade", async () => {
    h.conexoes = [CONEXAO];
    const { container } = render(tela(), { wrapper: ligado });
    await screen.findByTestId("grade-de-conexoes");
    const pecas = Array.from(container.querySelectorAll("[data-rd-conexoes]")).map((e) => e.getAttribute("data-rd-conexoes"));
    for (const p of ["barra", "busca", "contador", "criar", "grade", "cartao"]) expect(pecas).toContain(p);
  });

  it("ligado, a tela vazia marca o estado vazio", async () => {
    h.conexoes = [];
    const { container } = render(tela(), { wrapper: ligado });
    await screen.findByTestId("conexoes-vazio");
    expect(container.querySelector('[data-rd-conexoes="vazio"]')).not.toBeNull();
  });

  it("marcaDasConexoes (página de servidor): ligada devolve a peça, desligada undefined", () => {
    expect(marcaDasConexoes(true)("titulo")).toBe("titulo");
    expect(marcaDasConexoes(false)("titulo")).toBeUndefined();
  });
});

describe("redesign: conexões, CSS escopado pela chave", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: conexoes ";
  const FIM = "/* redesign: conexoes — fim";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
    return css.slice(i, f);
  }

  function erros(css: string): { regras: number; erros: string[] } {
    const out: string[] = [];
    let regras = 0;
    postcss.parse(css).walkAtRules((at) => {
      if (at.name !== "media") out.push(`@${at.name} não é permitido`);
    });
    postcss.parse(css).walkRules((r) => {
      regras++;
      for (const p of r.selectors) if (!p.trim().startsWith(ESCOPO)) out.push(`seletor sem escopo: ${p}`);
    });
    postcss.parse(css).walkDecls((d) => {
      if (d.important) out.push(`!important em ${d.prop}`);
    });
    return { regras, erros: out };
  }

  it('o bloco existe e todo seletor começa por [data-redesign="ligado"]', () => {
    const r = erros(bloco(CSS));
    expect(r.regras).toBeGreaterThan(15);
    expect(r.erros).toEqual([]);
  });

  it("controle negativo: a régua reprova seletor sem escopo", () => {
    const r = erros(`.x { color: red; } ${ESCOPO} .a, .b { color: red; }`);
    expect(r.erros).toContain("seletor sem escopo: .x");
    expect(r.erros).toContain("seletor sem escopo: .b");
  });
});
