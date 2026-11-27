import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { KanbanCard } from "@/components/kanban/KanbanCard";
import { SecaoDoDossie } from "@/components/kanban/SecaoDoDossie";
import { StageColumn } from "@/components/kanban/StageColumn";
import { buildCardInput } from "@/lib/kanban/card-state";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import type { Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

/**
 * Redesign, item B5 (Pipeline): com a chave DESLIGADA a tela é a de sempre —
 * nenhum `data-rd-pipeline` no DOM —; LIGADA, as peças levam a marca que o bloco
 * `/* redesign: pipeline *\/` de `app/globals.css` desenha, e toda regra desse
 * bloco começa por `[data-redesign="ligado"]` (fora de `@layer`, uma regra sem
 * escopo venceria qualquer tela com a chave desligada).
 *
 * Renderiza os componentes de verdade (cartão, coluna, seção da ficha); o que é
 * dublado são só as bordas de rede e de sessão, como em
 * `components/kanban/KanbanCard.densidade.test.tsx`.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useFusoDaOrganizacao: () => null,
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "o-1", currency: "BRL" }),
}));
// Os diálogos do menu de ações não fazem parte desta medida: o que se olha aqui
// é o CORPO do card. Dublados, eles não arrastam a org, a moeda e as rotas de
// cada um para dentro do caso.
vi.mock("./EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("./LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("./MoveToOtherPipelineDialog", () => ({ MoveToOtherPipelineDialog: () => null }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
  useLoseLead: () => ({ mutate: vi.fn(), isPending: false }),
  useMoveLeadToPipeline: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: [] }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

const AGORA = new Date("2026-10-27T12:00:00Z");
/** 5 dias parado na etapa: dá idade para o rodapé escrever "5d na etapa". */
const ENTRADA_NA_ETAPA = "2026-10-22T12:00:00Z";

const LEAD = {
  id: "l-1",
  title: "Proposta da ACME — renovação anual de contrato",
  value_cents: 250_000,
  currency: "BRL",
  tags: ["vip"],
  stage_changed_at: ENTRADA_NA_ETAPA,
  created_at: ENTRADA_NA_ETAPA,
  owner_kind: "user",
  owner_user_id: "u-1",
  owner_agent_id: null,
  owner_agent: null,
  owner_user: { full_name: "Marcos" },
  next_action: null,
  score: null,
  contact_id: "c-1",
  contact_phone: "+55 11 98888-7777",
  contact_email: "ana@exemplo.com",
  contact_links: [],
  conversa: {
    id: "conv-1",
    preview: "Quero saber o preço",
    last_message_at: "2026-10-26T10:00:00Z",
    unread: 0,
  },
  tarefas: [],
} as unknown as Lead;

const ETAPA = {
  id: "etapa-1",
  name: "Negociação",
  color: "#0139b0",
  position: 1,
} as unknown as Stage;

function comChave(ligado: boolean | null, filho: ReactNode) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = <QueryClientProvider client={cliente}>{filho}</QueryClientProvider>;
  return ligado === null ? (
    arvore
  ) : (
    <ProvedorDoRedesign ligado={ligado}>{arvore}</ProvedorDoRedesign>
  );
}

function montarCartao(ligado: boolean | null) {
  const card = buildCardInput(LEAD, {
    stageName: "Negociação",
    ownerNames: new Map([["u-1", "Marcos"]]),
    coolingIds: new Set<string>(),
    reactivations: new Map(),
    canonicalTags: [],
    now: AGORA,
  });
  return render(
    comChave(
      ligado,
      <DragDropContext onDragEnd={() => undefined}>
        <Droppable droppableId="etapa-1" type="LEAD">
          {() => (
            <div>
              <KanbanCard
                card={card}
                lead={LEAD}
                index={0}
                pipelineId="p-1"
                etapas={[]}
                denso={false}
              />
            </div>
          )}
        </Droppable>
      </DragDropContext>,
    ),
  );
}

function montarColuna(ligado: boolean | null, leads: Lead[]) {
  return render(
    comChave(
      ligado,
      <DragDropContext onDragEnd={() => undefined}>
        <StageColumn stage={ETAPA} leads={leads} pipelineId="p-1" />
      </DragDropContext>,
    ),
  );
}

function montarSecao(ligado: boolean | null) {
  return render(
    comChave(
      ligado,
      <SecaoDoDossie
        id="linha-do-tempo"
        titulo="Linha do tempo"
        recolhida={false}
        aoAlternar={() => undefined}
      >
        <p>conteúdo</p>
      </SecaoDoDossie>,
    ),
  );
}

function marcas(raiz: HTMLElement): string[] {
  return Array.from(raiz.querySelectorAll("[data-rd-pipeline]"))
    .map((el) => el.getAttribute("data-rd-pipeline") ?? "")
    .sort();
}

describe("redesign do Pipeline: desligado é a tela de sempre", () => {
  it.each([
    ["sem provedor", null],
    ["chave desligada", false],
  ] as const)(
    "%s: nenhum data-rd-pipeline no cartão, na coluna nem na seção da ficha",
    (_n, ligado) => {
      expect(marcas(montarCartao(ligado).container)).toEqual([]);
      expect(marcas(montarColuna(ligado, [LEAD]).container)).toEqual([]);
      expect(marcas(montarColuna(ligado, []).container)).toEqual([]);
      expect(marcas(montarSecao(ligado).container)).toEqual([]);
    },
  );

  it("desligado, o cartão tem as mesmas classes de antes (o atributo é a única diferença com a chave ligada)", () => {
    const fora = montarCartao(false).container.querySelector('[role="group"]');
    const dentro = montarCartao(true).container.querySelector('[role="group"]');
    expect(fora?.className).toBeTruthy();
    expect(dentro?.className).toBe(fora?.className);
  });
});

describe("redesign do Pipeline: ligado marca as peças", () => {
  it("cartão: raiz, identidade, título, valor e rodapé", () => {
    const { container } = montarCartao(true);
    // Onda 3: identidade e valor ganham marca para o valor subir à linha do título.
    expect(marcas(container)).toEqual([
      "cartao",
      "cartao-identidade",
      "cartao-rodape",
      "cartao-titulo",
      "cartao-valor",
    ]);
    expect(container.querySelector('[data-rd-pipeline="cartao-valor"]')?.getAttribute("data-testid")).toBe(
      "card-valor",
    );
    const cartao = container.querySelector('[data-rd-pipeline="cartao"]');
    expect(cartao?.getAttribute("role")).toBe("group");
    expect(cartao?.querySelector('[data-testid="card-valor"]')).not.toBeNull();
    expect(
      cartao?.querySelector("[data-tempo-na-etapa]")?.closest('[data-rd-pipeline="cartao-rodape"]'),
    ).not.toBeNull();
  });

  it("coluna: raiz, cabeçalho preso, corpo de soltar — e o aviso de vazia só quando vazia", () => {
    const cheia = montarColuna(true, [LEAD]).container;
    const coluna = cheia.querySelector('[data-rd-pipeline="coluna"]');
    expect(coluna?.getAttribute("data-etapa-do-quadro")).toBe("etapa-1");
    expect(
      coluna
        ?.querySelector('[data-rd-pipeline="coluna-topo"]')
        ?.hasAttribute("data-cabecalho-da-etapa"),
    ).toBe(true);
    expect(
      coluna?.querySelector('[data-rd-pipeline="coluna-corpo"] [data-rd-pipeline="cartao"]'),
    ).not.toBeNull();
    expect(cheia.querySelector('[data-rd-pipeline="coluna-vazia"]')).toBeNull();

    const vazia = montarColuna(true, []).container;
    expect(vazia.querySelector('[data-rd-pipeline="coluna-vazia"]')).not.toBeNull();
  });

  it("seção da ficha: a marca vai junto do data-secao que já existia", () => {
    const secao = montarSecao(true).container.querySelector('[data-rd-pipeline="secao"]');
    expect(secao?.getAttribute("data-secao")).toBe("linha-do-tempo");
  });
});

describe("as peças fora do jsdom deste arquivo usam a mesma marca condicional", () => {
  // O quadro, a ficha, a conversa, o cabeçalho e a lista de funis dependem de
  // rede e de sessão demais para montar aqui; o que se cobra deles é a FORMA:
  // a marca sai sempre de `rd(...)` (undefined desligada), nunca de string fixa.
  const ARQUIVOS: Record<string, string[]> = {
    "app/app/pipelines/[id]/_client.tsx": ["tela", "cabecalho", "visoes", "identidade"],
    "app/app/kanban/_client.tsx": ["funis"],
    "components/kanban/FilterBar.tsx": ["filtros"],
    "components/kanban/KanbanBoard.tsx": ["quadro"],
    "components/kanban/LeadDossier.tsx": ["ficha", "ficha-resumo"],
    "components/kanban/ConversaNoDossie.tsx": ["conversa"],
  };
  it.each(Object.entries(ARQUIVOS))("%s", (arquivo, pecas) => {
    const fonte = fs.readFileSync(path.join(process.cwd(), arquivo), "utf8");
    expect(fonte).toContain("useMarcaDoPipeline()");
    expect(fonte).not.toMatch(/data-rd-pipeline="/);
    for (const p of pecas) expect(fonte).toContain(`data-rd-pipeline={rd("${p}")}`);
  });
});

describe("o bloco CSS do Pipeline é escopado pela chave", () => {
  const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: pipeline */";
  const FIM = "/* redesign: pipeline — fim */";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
    if (css.indexOf(INICIO, i + 1) >= 0) throw new Error("marcador de início repetido");
    return css.slice(i + INICIO.length, f);
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
      for (const p of partes(r.selector))
        if (!p.startsWith(ESCOPO)) erros.push(`seletor sem escopo: ${p}`);
    });
    raiz.walkDecls((d) => {
      if (d.important) erros.push(`!important em ${d.prop}`);
      // O arraste do @hello-pangea/dnd move o cartão por transform; peças que
      // aparecem no hover e o `sr-only` vivem de opacity e display.
      if (["transform", "transition", "opacity"].includes(d.prop)) erros.push(`${d.prop} no bloco`);
    });
    return { regras, erros };
  }

  it("existe, tem regras e vem DEPOIS do bloco dos componentes", () => {
    expect(violacoes(bloco(CSS)).regras).toBeGreaterThan(20);
    expect(CSS.indexOf(INICIO)).toBeGreaterThan(CSS.indexOf("/* redesign: componentes — fim */"));
  });

  it('todo seletor começa por [data-redesign="ligado"], sem !important, transform ou opacity', () => {
    expect(violacoes(bloco(CSS)).erros).toEqual([]);
  });

  it("controle negativo: a régua reprova o que deve", () => {
    const { erros } = violacoes(
      `.x{color:red} ${ESCOPO} .a, .b{color:red} ${ESCOPO} .c{transform:none} @keyframes k{}`,
    );
    expect(erros).toContain("seletor sem escopo: .x");
    expect(erros).toContain("seletor sem escopo: .b");
    expect(erros).toContain("transform no bloco");
    expect(erros.some((e) => e.startsWith("@keyframes"))).toBe(true);
  });
});
