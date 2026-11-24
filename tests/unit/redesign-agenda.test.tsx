import { render } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import type { Agendamento } from "@/components/agenda/tipos";
import { RiskRadarList } from "@/app/app/radar/_components/RiskRadarList";
import { useAtRiskLeads } from "@/hooks/leads/useAtRiskLeads";
import { marcaDaAgenda } from "@/lib/redesign/agenda";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

/**
 * Redesign (Agenda e Radar): desligado, nenhum `data-rd-agenda` no DOM; ligado,
 * as peças principais levam a marca; e todo seletor do bloco
 * `/* redesign: agenda *\/` de `app/globals.css` começa por
 * `[data-redesign="ligado"]`.
 */

vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const QUARTA = new Date("2026-09-16T12:00:00-03:00");
const AGENDAMENTO = {
  id: "a-1",
  titulo: "Consulta",
  responsavelId: "p-1",
  comeca: "2026-09-16T13:00:00-03:00",
  termina: "2026-09-16T14:00:00-03:00",
  origem: "ui",
  situacao: "confirmed",
} as Agendamento;

function emVolta(ligado: boolean | null, filho: ReactNode) {
  return ligado === null ? filho : <ProvedorDoRedesign ligado={ligado}>{filho}</ProvedorDoRedesign>;
}

function montarGrade(ligado: boolean | null) {
  return render(
    emVolta(
      ligado,
      <GradeDaAgenda
        visao="semana"
        ancora={QUARTA}
        agora={QUARTA}
        fuso="America/Sao_Paulo"
        agendamentos={[AGENDAMENTO]}
        pessoas={[]}
      />,
    ),
  );
}

function montarRadar(ligado: boolean | null, vazio = false) {
  vi.mocked(useAtRiskLeads).mockReturnValue({
    data: {
      items: vazio
        ? []
        : [
            {
              id: "l-1",
              title: "Negócio",
              risk: "critico",
              hours_since_activity: 72,
              contact_name: "Ana",
              conversation_id: null,
              pipeline_id: "p-1",
              in_flight: false,
              next_followup_at: null,
              agenda: null,
              owner_kind: null,
              owner_user_id: null,
              assignee_kind: null,
            },
          ],
      counts: { critico: vazio ? 0 : 1, em_risco: 0, em_voo: 0 },
      total: vazio ? 0 : 1,
      sem_proximo_passo: vazio
        ? []
        : [
            {
              id: "d1",
              contact_id: "c1",
              contact_name: "X",
              aberta_em: "2026-01-01",
              horas_aberta: 5,
              origem: "y",
              conversation_id: null,
            },
          ],
      total_sem_proximo_passo: 0,
      propostas_vencidas_sem_retomada: [],
      propostas_esperando_revisao: [],
    },
    isLoading: false,
  } as never);
  return render(emVolta(ligado, <RiskRadarList />));
}

function marcas(raiz: HTMLElement): string[] {
  return Array.from(raiz.querySelectorAll("[data-rd-agenda]"))
    .map((el) => el.getAttribute("data-rd-agenda") ?? "")
    .sort();
}

describe("redesign da Agenda e do Radar: desligado é a tela de sempre", () => {
  it.each([
    ["sem provedor", null],
    ["chave desligada", false],
  ] as const)("%s: nenhum data-rd-agenda na grade nem no radar", (_n, ligado) => {
    expect(marcas(montarGrade(ligado).container)).toEqual([]);
    expect(marcas(montarRadar(ligado).container)).toEqual([]);
    expect(marcas(montarRadar(ligado, true).container)).toEqual([]);
  });

  it("a marca pura de servidor desligada devolve undefined", () => {
    expect(marcaDaAgenda(false)("tela")).toBeUndefined();
    expect(marcaDaAgenda(true)("tela")).toBe("tela");
  });

  it("as classes da grade são as mesmas com a chave ligada", () => {
    const fora = montarGrade(false).container.querySelector('[data-testid="grade-da-agenda"]');
    const dentro = montarGrade(true).container.querySelector('[data-testid="grade-da-agenda"]');
    expect(dentro?.className).toBe(fora?.className);
  });
});

describe("redesign da Agenda e do Radar: ligado marca as peças", () => {
  it("grade e compromisso", () => {
    const { container } = montarGrade(true);
    expect(marcas(container)).toEqual(["compromisso", "grade"]);
    expect(
      container.querySelector('[data-rd-agenda="grade"] [data-rd-agenda="compromisso"]'),
    ).not.toBeNull();
  });

  it("radar com demandas: aviso, contagem, lista e item", () => {
    const { container } = montarRadar(true);
    expect(marcas(container)).toEqual(["radar-aviso", "radar-contagem", "radar-item", "radar-lista"]);
    expect(
      container.querySelector('[data-rd-agenda="radar-lista"] [data-rd-agenda="radar-item"]'),
    ).not.toBeNull();
  });

  it("radar sem nada em risco: só o vazio", () => {
    expect(marcas(montarRadar(true, true).container)).toEqual(["radar-vazio"]);
  });
});

describe("as peças fora do jsdom deste arquivo usam a mesma marca condicional", () => {
  const ARQUIVOS: Record<string, { hook: string; pecas: string[] }> = {
    "app/app/agenda/_client.tsx": { hook: "useMarcaDaAgenda()", pecas: ["tela", "cabecalho", "barra", "visoes"] },
    "app/app/radar/page.tsx": { hook: "marcaDaAgenda(await redesignNaRequisicao())", pecas: ["radar-tela", "radar-cabecalho"] },
  };
  it.each(Object.entries(ARQUIVOS))("%s", (arquivo, { hook, pecas }) => {
    const fonte = fs.readFileSync(path.join(process.cwd(), arquivo), "utf8");
    expect(fonte).toContain(hook);
    expect(fonte).not.toMatch(/data-rd-agenda="/);
    for (const p of pecas) expect(fonte).toContain(`data-rd-agenda={rd("${p}")}`);
  });

  it("agenda.ts não importa a chave (server-only) nem é componente cliente", () => {
    const fonte = fs.readFileSync(path.join(process.cwd(), "lib/redesign/agenda.ts"), "utf8");
    expect(fonte).not.toMatch(/from "@\/lib\/redesign\/chave"/);
    expect(fonte).not.toMatch(/^"use client"/);
  });
});

describe("o bloco CSS da Agenda é escopado pela chave", () => {
  const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: agenda ──";
  const FIM = "/* redesign: agenda — fim ──";
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
      if (at.name !== "media") erros.push(`@${at.name} não é permitido no bloco`);
    });
    raiz.walkRules((r) => {
      regras++;
      for (const p of partes(r.selector)) if (!p.startsWith(ESCOPO)) erros.push(`seletor sem escopo: ${p}`);
    });
    return { erros, regras };
  }

  it("toda regra começa por [data-redesign=\"ligado\"]", () => {
    const { erros, regras } = violacoes(bloco(CSS));
    expect(regras).toBeGreaterThan(10);
    expect(erros).toEqual([]);
  });

  it("controle negativo: a régua reprova o que deve", () => {
    expect(violacoes(`.solto { color: red }`).erros).toHaveLength(1);
    expect(violacoes(`[data-redesign="ligado"] a, .b { color: red }`).erros).toHaveLength(1);
    expect(violacoes(`@layer x { [data-redesign="ligado"] a { color: red } }`).erros.length).toBeGreaterThan(0);
    expect(violacoes(`[data-redesign="ligado"] a { color: red }`).erros).toEqual([]);
  });
});
