/**
 * O ROTEAMENTO NO REDESIGN — desligado é a tela de sempre, ligado é a nova.
 *
 * Os componentes (editor de roteador, resultados do roteamento, dossiê do
 * follow-up) ganham `data-rd-roteamento="<peça>"` SÓ com a chave ligada
 * (`useMarcaDoRoteamento`), e o bloco "redesign: roteamento" de
 * `app/globals.css` os desenha. Provado aqui:
 *
 *   1. DOM — sem o provedor do redesign nenhum atributo é escrito; com ele, as
 *      peças principais aparecem.
 *   2. CSS — todo seletor do bloco começa por `[data-redesign="ligado"]`.
 *
 * NÃO prova a aparência: jsdom não pinta.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import postcss from "postcss";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FollowupEnrollmentDossie } from "@/hooks/followup/useFollowupEnrollment";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { modulos_ligados: [] } }),
  usePermission: () => true,
  usePaisDaOrgAtiva: () => "BR",
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({
  useLocaleDeData: () => undefined,
  useTagDeIdioma: () => "pt-BR",
}));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({ useFollowupFlows: () => ({ data: undefined }) }));
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  usePipelines: () => ({ data: undefined }),
  usePipelineStages: () => ({ data: undefined }),
}));
vi.mock("@/hooks/ai/useRouters", () => {
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useRouter: () => ({ data: undefined }),
    useUpdateRouter: mut,
    useDeleteRouter: mut,
    useSaveMembers: mut,
    useTestRouter: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, data: undefined }),
  };
});

const dossie = vi.hoisted(() => {
  const data: FollowupEnrollmentDossie = {
    id: "9f2c1b6a-4d7e-4f8a-9c0b-1d2e3f4a5b6c",
    status: "active",
    current_node_id: "n1",
    next_eval_at: null,
    claimed_until: null,
    motor_ocupado: false,
    started_at: "2026-09-01T10:00:00Z",
    completed_at: null,
    updated_at: "2026-09-01T10:00:00Z",
    outcome: null,
    cancel_reason: null,
    last_error: null,
    attempts: 0,
    max_attempts: 5,
    steps_taken: 2,
    contact: { id: "c1", name: "Maria" },
    flow: { pointer_id: "p1", name: "Vendas", version_id: "v1" },
    agent_name: null,
    no_atual: null,
    nos: [],
    saidas: [],
    eventos: [],
    eventos_truncados: false,
    plano_de_tempo: null,
    autores: {},
  };
  return { data };
});
vi.mock("@/hooks/followup/useFollowupEnrollment", () => ({
  useFollowupEnrollment: () => ({ data: dossie.data, isLoading: false, isError: false }),
  useIntervirNoFollowup: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/followup/useFollowupQueue", () => ({
  useCancelFollowupEnrollment: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { DossieDoFollowup } from "@/app/app/ai/followups/enrollments/[id]/_components/DossieDoFollowup";
import { RouterEditorClient } from "@/app/app/ai/routers/[id]/_client";
import { RoteamentoResultados } from "@/app/app/ai/runs/_components/RoteamentoResultados";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import { marcaDoRoteamento } from "@/lib/redesign/roteamento";

function ligado({ children }: { children: ReactNode }) {
  return <ProvedorDoRedesign ligado>{children}</ProvedorDoRedesign>;
}

function editor() {
  return (
    <RouterEditorClient
      routerId="r1"
      initialState={{
        router: { id: "r1", name: "Roteador", channel_session_id: "s1", is_active: true, config: {}, fallback_agent_id: null },
        members: [
          {
            id: "m1",
            agent_id: "a1",
            intent_name: "financiamento",
            intent_description: "quer financiar",
            examples: [],
            position: 0,
            flow_pointer_id: null,
          } as never,
        ],
      }}
      agents={[{ id: "a1", name: "Agente" }]}
      channelSessions={[]}
      classifierModels={[]}
    />
  );
}

const CASO = {
  id: "33333333-3333-4333-8333-333333333333",
  router_id: "44444444-4444-4444-8444-444444444444",
  conversation_id: null,
  modo: "jev_sob_demanda",
  context_message_count: 8,
  origem: "jev",
  motivo_reserva: null,
  intent_jev: "vendas",
  intent_tradicional: null,
  intent_final: "vendas",
  agent_id_final: null,
  agent_id_esperado: null,
  modelo_jev: "jev-1",
  destino_jev: "a",
  destino_tradicional: null,
  concordou_destino: null,
  revisao: null,
  custo_jev_cents: 0.01,
  custo_tradicional_cents: 0,
  custo_incompleto: false,
  tempo_total_ms: 120,
  created_at: "2026-09-30T12:00:00Z",
};
function resposta(casos: unknown[]) {
  return {
    roteadores: [{ id: CASO.router_id, name: "Principal" }],
    casos,
    membros: [],
    pode_revisar: false,
    resumo: {
      total: casos.length, limite_amostra: 500, periodo_dias: 30, sem_reserva: 1, reservas: 0,
      motivos_reserva: {}, custo_total_cents: 0.01, custos_incompletos: 0, mediana_ms: 120, p95_ms: 120,
      comparacoes_destino: 0, concordancias_destino: 0, comparacoes_intencao: 0, concordancias_intencao: 0,
      revisados: 0, corretos_revisados: 0,
    },
  };
}
function stubFetch(casos: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: resposta(casos) }), { status: 200 })));
}

const pecas = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("[data-rd-roteamento]")).map((e) => e.getAttribute("data-rd-roteamento"));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("redesign: roteamento, DOM", () => {
  it("desligado, editor, resultados e dossiê não escrevem nenhum data-rd-roteamento", async () => {
    const e = render(editor());
    expect(screen.getByDisplayValue("financiamento")).toBeTruthy();
    expect(e.container.querySelectorAll("[data-rd-roteamento]")).toHaveLength(0);
    cleanup();

    stubFetch([CASO]);
    const r = render(<RoteamentoResultados />);
    await screen.findByTestId(`roteamento-${CASO.id}`);
    expect(r.container.querySelectorAll("[data-rd-roteamento]")).toHaveLength(0);
    cleanup();

    const d = render(<DossieDoFollowup id={dossie.data.id} canWrite />);
    expect(screen.getByTestId("dossie-onde-esta")).toBeTruthy();
    expect(d.container.querySelectorAll("[data-rd-roteamento]")).toHaveLength(0);
  });

  it("ligado, o editor marca página, cabeçalho, seções, intenção e teste", () => {
    const { container } = render(editor(), { wrapper: ligado });
    const p = pecas(container);
    for (const x of ["pagina", "cabecalho", "voltar", "estado", "secao", "secao-titulo", "intencao", "teste"]) {
      expect(p).toContain(x);
    }
  });

  it("ligado, os resultados marcam cabeçalho, filtros, resumo e caso", async () => {
    stubFetch([CASO]);
    const { container } = render(<RoteamentoResultados />, { wrapper: ligado });
    await screen.findByTestId(`roteamento-${CASO.id}`);
    const p = pecas(container);
    for (const x of ["pagina", "cabecalho", "titulo", "descricao", "filtros", "resumo", "indicador", "caso"]) {
      expect(p).toContain(x);
    }
  });

  it("ligado, os resultados vazios marcam o estado vazio", async () => {
    stubFetch([]);
    const { container } = render(<RoteamentoResultados />, { wrapper: ligado });
    await screen.findByText("Ainda não há decisões de roteamento nesses filtros.");
    expect(pecas(container)).toContain("vazio");
  });

  it("ligado, o dossiê marca cabeçalho, resumo, seção e ações", () => {
    const { container } = render(<DossieDoFollowup id={dossie.data.id} canWrite />, { wrapper: ligado });
    const p = pecas(container);
    for (const x of ["pagina", "cabecalho", "voltar", "titulo", "estado", "dossie-resumo", "dossie-secao", "dossie-acoes"]) {
      expect(p).toContain(x);
    }
    expect(screen.getByTestId("dossie-status")).toBeTruthy();
  });

  it("marcaDoRoteamento (página de servidor): ligada devolve a peça, desligada undefined", () => {
    expect(marcaDoRoteamento(true)("area")).toBe("area");
    expect(marcaDoRoteamento(false)("area")).toBeUndefined();
  });
});

describe("redesign: roteamento, CSS escopado pela chave", () => {
  const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: roteamento ";
  const FIM = "/* redesign: roteamento — fim";
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
