import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChecklistDoInicio } from "@/app/app/inicio/_components/ChecklistDoInicio";
import { ListaDeTarefas } from "@/app/app/tasks/_components/ListaDeTarefas";
import { marcaDoInicio } from "@/lib/redesign/inicio";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import type { PassoDoInicio } from "@/lib/inicio/primeiros-passos";
import type { Tarefa } from "@/lib/tarefas/tipos";

/**
 * Redesign (Início e Tarefas): desligado, nenhum `data-rd-inicio` no DOM; ligado,
 * as peças principais levam a marca; e todo seletor do bloco
 * `/* redesign: inicio *\/` de `app/globals.css` começa por
 * `[data-redesign="ligado"]`. Renderiza os componentes de verdade; só as bordas
 * de sessão e de rede são dubladas.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "u-1" }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/components/auth/ReenviarConfirmacaoBotao", () => ({ ReenviarConfirmacaoBotao: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

const PASSOS = [
  { id: "email", tipo: "obrigatorio", feito: false, titulo: "Confirmar e-mail", descricao: "d", cta: "Ir", href: "/app/x" },
  { id: "canal", tipo: "opcional", feito: true, titulo: "Conectar canal", descricao: "d", cta: "Ver", href: "/app/y" },
] as unknown as PassoDoInicio[];
const CONTAGEM = {
  obrigatoriosFeitos: 0,
  obrigatoriosTotal: 1,
  obrigatoriosFaltando: 1,
  opcionaisFeitos: 1,
  opcionaisTotal: 1,
};

const TAREFA = {
  id: "t-1",
  title: "Ligar de volta",
  description: null,
  priority: "high",
  status: "pending",
  due_date: "2026-10-20T12:00:00Z",
  assigned_to: null,
  lead: { id: "l-1", title: "ACME" },
} as unknown as Tarefa;

function pecas(c: HTMLElement): string[] {
  return Array.from(c.querySelectorAll("[data-rd-inicio]")).map((e) => e.getAttribute("data-rd-inicio") ?? "");
}

function montar(ligado: boolean, mostrarNegocio = true) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ProvedorDoRedesign ligado={ligado}>
        <ChecklistDoInicio passos={PASSOS} contagem={CONTAGEM} />
        <ListaDeTarefas
          tarefas={[TAREFA]}
          podeEditar
          aoAlternarConcluida={vi.fn()}
          aoEditar={vi.fn()}
          aoApagar={vi.fn()}
          mostrarNegocio={mostrarNegocio}
        />
      </ProvedorDoRedesign>
    </QueryClientProvider>,
  );
}

describe("redesign de Início e Tarefas: desligado é a tela de sempre", () => {
  it("nenhum data-rd-inicio no DOM", () => {
    expect(pecas(montar(false).container)).toEqual([]);
  });
  it("marcaDoInicio(false) devolve undefined para toda peça", () => {
    expect(marcaDoInicio(false)("tela")).toBeUndefined();
  });
});

describe("redesign de Início e Tarefas: ligado marca as peças", () => {
  it("o checklist e a lista de tarefas levam a marca", () => {
    const p = pecas(montar(true).container);
    for (const peca of [
      "progresso",
      "secao-titulo",
      "passo",
      "passo-cartao",
      "tarefas-lista",
      "tarefas-faixa",
      "tarefas-grupo",
      "tarefas-linha",
      "tarefas-prioridade",
    ])
      expect(p).toContain(peca);
  });
  it("a lista dentro do dossiê (mostrarNegocio=false) não é marcada", () => {
    const p = pecas(montar(true, false).container).filter((x) => x.startsWith("tarefas-"));
    expect(p).toEqual([]);
  });
  it("marcaDoInicio(true) devolve a peça", () => {
    expect(marcaDoInicio(true)("tarefas-tela")).toBe("tarefas-tela");
  });
});

describe("o bloco CSS de Início e Tarefas é escopado pela chave", () => {
  const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: inicio ───────────────────────────────";
  const FIM = "/* redesign: inicio — fim ─────────────────────── */";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
    return css.slice(i, f);
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
      erros.push(`@${at.name} ${at.params} não é permitido no bloco`);
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

  it("existe, tem regras e vem depois do bloco do Pipeline", () => {
    expect(violacoes(bloco(CSS)).regras).toBeGreaterThan(20);
    expect(CSS.indexOf(INICIO)).toBeGreaterThan(CSS.indexOf("/* redesign: pipeline — fim */"));
    expect(CSS.indexOf(INICIO, CSS.indexOf(INICIO) + 1)).toBe(-1);
  });

  it('todo seletor começa por [data-redesign="ligado"] e não há !important', () => {
    expect(violacoes(bloco(CSS)).erros).toEqual([]);
  });

  it("controle negativo: a régua reprova o que deve", () => {
    const { erros } = violacoes(`.x{color:red} ${ESCOPO} .a, .b{color:red} ${ESCOPO} .c{color:red !important}`);
    expect(erros).toContain("seletor sem escopo: .x");
    expect(erros).toContain("seletor sem escopo: .b");
    expect(erros).toContain("!important em color");
  });
});
