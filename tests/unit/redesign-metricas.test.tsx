import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CartaoKpi, Painel } from "@/app/app/metrics/_components/graficos";
import { MetaDoMesPanel } from "@/app/app/metrics/_components/MetaDoMesPanel";
import { AgentCard } from "@/app/app/ai/agents/_components/AgentCard";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import { marcaDasMetricas } from "@/lib/redesign/metricas";

/**
 * Redesign (Desempenho e Agentes de IA): chave DESLIGADA = nenhum
 * `data-rd-metricas` no DOM; LIGADA = as peças levam a marca que o bloco
 * `redesign: metricas` de `app/globals.css` desenha, e todo seletor desse bloco
 * começa por `[data-redesign="ligado"]`.
 */
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useFusoDaOrganizacao: () => null,
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "o-1", currency: "BRL" }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// O menu de ações tem diálogos e mutações próprios; não fazem parte desta medida.
vi.mock("@/app/app/ai/agents/_components/AgentRowMenu", () => ({ AgentRowMenu: () => null }));

const AGENTE = {
  id: "a-1",
  name: "Luna",
  description: "Atende o WhatsApp",
  kind: "mcp_agent",
  priority: 1,
  is_default: false,
  model: "claude-sonnet-4-6",
  versao_publicada: null,
  versoes_rascunho: [],
} as unknown as AgentRow;

function Tela() {
  return (
    <>
      <CartaoKpi titulo="Ganhos" valor="12" detalhe="R$ 1.000" />
      <Painel titulo="Funil">
        <p>conteúdo</p>
      </Painel>
      <MetaDoMesPanel estado="vazio" periodo={null} metas={[]} podeConfigurar={false} valores={null} />
      <AgentCard agent={AGENTE} canWrite={false} />
    </>
  );
}

function renderiza(ligado: boolean, ui: ReactNode = <Tela />) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ProvedorDoRedesign ligado={ligado}>{ui}</ProvedorDoRedesign>
    </QueryClientProvider>,
  );
}

describe("marcas das telas Desempenho e Agentes", () => {
  it("desligada: nenhum data-rd-metricas no DOM", () => {
    const { container } = renderiza(false);
    expect(container.querySelectorAll("[data-rd-metricas]")).toHaveLength(0);
    expect(container.textContent).toContain("Luna");
  });

  it("ligada: as peças principais aparecem", () => {
    const { container } = renderiza(true);
    const pecas = new Set(
      Array.from(container.querySelectorAll("[data-rd-metricas]")).map((e) => e.getAttribute("data-rd-metricas")),
    );
    for (const p of ["kpi", "painel", "meta", "agentes-cartao"]) expect(pecas.has(p)).toBe(true);
  });

  it("a regra pura: desligada devolve undefined", () => {
    expect(marcaDasMetricas(false)("tela")).toBeUndefined();
    expect(marcaDasMetricas(true)("tela")).toBe("tela");
  });

  it("as páginas de servidor marcam pela mesma regra, sem importar server-only no módulo", () => {
    const lib = fs.readFileSync(path.join(process.cwd(), "lib/redesign/metricas.ts"), "utf8");
    expect(lib).not.toMatch(/"use client"/);
    expect(lib).not.toMatch(/from "@\/lib\/redesign\/chave"/);
    for (const f of ["app/app/metrics/page.tsx", "app/app/ai/agents/page.tsx"]) {
      const fonte = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      expect(fonte).toContain("marcaDasMetricas(redesignLigado())");
      expect(fonte).not.toMatch(/data-rd-metricas="/);
    }
  });
});

describe("o bloco CSS de métricas é escopado pela chave", () => {
  const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: metricas ───────────────────────────────";
  const FIM = "/* redesign: metricas — fim ─────────────────────── */";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
    if (css.indexOf(INICIO, i + 1) >= 0) throw new Error("marcador de início repetido");
    // O marcador abre o comentário de cabeçalho; o CSS começa depois que ele fecha.
    return css.slice(css.indexOf("*/", i) + 2, f);
  }

  function partes(seletor: string): string[] {
    const out: string[] = [];
    let nivel = 0;
    let atual = "";
    for (const ch of seletor) {
      if (ch === "(" || ch === "[") nivel++;
      if (ch === ")" || ch === "]") nivel--;
      if (ch === "," && nivel === 0) {
        out.push(atual);
        atual = "";
      } else atual += ch;
    }
    out.push(atual);
    return out.map((s) => s.replace(/\s+/g, " ").trim());
  }

  function violacoes(css: string) {
    const raiz = postcss.parse(css);
    const erros: string[] = [];
    let regras = 0;
    raiz.walkAtRules((at) => {
      if (at.name !== "media") erros.push(`@${at.name} ${at.params} não é permitido no bloco`);
    });
    raiz.walkRules((r) => {
      regras++;
      for (const p of partes(r.selector)) if (!p.startsWith(ESCOPO)) erros.push(`seletor sem escopo: ${p}`);
    });
    raiz.walkDecls((d) => {
      if (d.important) erros.push(`!important em ${d.prop}`);
    });
    return { regras, erros };
  }

  it("existe, tem regras e vem DEPOIS do bloco dos componentes", () => {
    expect(violacoes(bloco(CSS)).regras).toBeGreaterThan(20);
    expect(CSS.indexOf(INICIO)).toBeGreaterThan(CSS.indexOf("/* redesign: componentes — fim */"));
  });

  it('todo seletor começa por [data-redesign="ligado"], sem !important', () => {
    expect(violacoes(bloco(CSS)).erros).toEqual([]);
  });

  it("controle negativo: a régua reprova o que deve", () => {
    const { erros } = violacoes(
      `.x{color:red} ${ESCOPO} .a, .b{color:red} ${ESCOPO} .c{color:red!important} @keyframes k{}`,
    );
    expect(erros).toContain("seletor sem escopo: .x");
    expect(erros).toContain("seletor sem escopo: .b");
    expect(erros).toContain("!important em color");
    expect(erros.some((e) => e.startsWith("@keyframes"))).toBe(true);
  });
});
