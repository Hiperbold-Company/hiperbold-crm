/**
 * ONDA 4 DO REDESIGN — IA (Agentes, Conhecimento, Casos, Roteadores e
 * Follow-ups) no v49.
 *
 * Retratos da chave DESLIGADA, escritos ANTES da onda 4 contra o código de
 * sempre. A onda pode reagrupar elementos com a chave ligada; com ela
 * desligada, o HTML tem de ser o mesmo, byte a byte.
 */
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useTagDeIdioma: () => "pt-BR",
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useFusoDaOrganizacao: () => "America/Sao_Paulo",
  useActiveOrg: () => ({ orgId: "org-1", name: "Loja", role: "admin" }),
  useAuth: () => ({ user: { id: "u-1" }, activeOrg: { orgId: "org-1", role: "admin" } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const AGENTE = {
  id: "a-1",
  name: "Atendimento de vendas",
  description: "Responde dúvidas sobre planos e preços",
  kind: "mcp_agent",
  priority: 1,
  is_default: false,
  is_archived: false,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  versao_publicada: null,
  versoes_rascunho: [],
};
vi.mock("@/hooks/ai/useAgents", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAgentsList: () => ({ data: [AGENTE], isLoading: false, isError: false }),
}));

const ROTEADOR = {
  id: "r-1",
  name: "Entrada de vendas",
  channel_session_id: "cs-1",
  is_active: true,
  fallback_agent_id: "a-1",
  member_count: 4,
  updated_at: "2026-11-20T12:00:00Z",
};
vi.mock("@/hooks/ai/useRouters", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useRouters: () => ({ data: { routers: [ROTEADOR] }, isLoading: false, isError: false }),
  useCreateRouter: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/ai/useCases", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCases: () => ({
    isLoading: false,
    data: {
      open_count: 1,
      cases: [
        {
          id: "case-1",
          title: "Desconto acima da alçada",
          summary: "Quer 30% de desconto",
          blocker: "Fora da política",
          status: "awaiting_human",
          opened_at: "2026-11-20T12:00:00Z",
          conversation_id: "conv-1",
          contact_name: "Maria Silva",
          contact_phone: "+5511999990000",
        },
      ],
    },
  }),
}));
vi.mock("@/app/app/ai/cases/_components/CaseDetail", () => ({ CaseDetail: () => null }));

const FLUXO = { id: "f-1", name: "Retomar quem parou", status: "active", active_version_id: "v1", handoff_policy: "pause", surface: "followup", updated_at: "2026-11-03T12:00:00Z" };
vi.mock("@/hooks/followup/useFollowupFlows", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useFollowupFlows: () => ({ data: [FLUXO], isLoading: false, isError: false, refetch: vi.fn(), isFetching: false }),
}));

import { AgentsList } from "@/app/app/ai/agents/_components/AgentsList";
import { CaseList } from "@/app/app/ai/cases/_components/CaseList";
import { FlowsList } from "@/app/app/ai/followups/_components/FlowsList";
import { AcervoClient } from "@/app/app/ai/knowledge/sources/_client";
import { RoutersClient } from "@/app/app/ai/routers/_client";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import { marcaDaIa } from "@/lib/redesign/ia";

function Envoltorio({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const MATERIAL = {
  id: "s-1",
  agent_id: null,
  organization_id: "org-1",
  source_type: "file",
  name: "Tabela de preços.pdf",
  status: "ready",
  last_index_status: "success",
  last_index_error: null,
  last_indexed_at: "2026-11-22T12:00:00Z",
  chunks_count: 42,
  is_active: true,
  source_metadata: {},
  active_kb_version_id: "kb-1",
  created_at: "2026-11-01T12:00:00Z",
  updated_at: "2026-11-22T12:00:00Z",
};
const CHAVE = { pode_indexar: true, origem: "openai", explicacao: null, chave_em_uso: "openai", avisos: [], familia: "openai" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T15:00:00Z"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("onda 4 — IA, retrato da chave DESLIGADA", () => {
  it("Agentes: lista", () => {
    const { container } = render(
      <Envoltorio>
        <AgentsList initialData={[AGENTE] as never} canWrite />
      </Envoltorio>,
    );
    expect(container.innerHTML).toContain("Atendimento de vendas");
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("Conhecimento: acervo com um material", () => {
    const { container } = render(
      <Envoltorio>
        <AcervoClient initialSources={[MATERIAL] as never} initialChave={CHAVE as never} agentes={[{ id: "a-1", nome: "Atendimento de vendas", materiais: ["s-1"] }]} />
      </Envoltorio>,
    );
    expect(container.innerHTML).toContain("Tabela de preços.pdf");
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("Casos: lista", () => {
    const { container } = render(
      <Envoltorio>
        <CaseList />
      </Envoltorio>,
    );
    expect(container.innerHTML).toContain("Desconto acima da alçada");
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("Roteadores: lista", () => {
    const { container } = render(
      <Envoltorio>
        <RoutersClient initialState={{ routers: [ROTEADOR] }} channelSessions={[{ id: "cs-1", name: "WhatsApp Vendas" }] as never} />
      </Envoltorio>,
    );
    expect(container.innerHTML).toContain("Entrada de vendas");
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("Follow-ups: lista", () => {
    const { container } = render(
      <Envoltorio>
        <FlowsList initialData={[FLUXO] as never} canWrite surface="followup" />
      </Envoltorio>,
    );
    expect(container.innerHTML).toContain("Retomar quem parou");
    expect(container.innerHTML).toMatchSnapshot();
  });
});

/* ── Chave LIGADA: as peças novas aparecem e nenhum controle muda ─────────── */

/** Botões e links na ordem do DOM: rótulo + data-testid + disabled (+ destino do link). */
function controles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("button, a[href], [role='tab']")).map((el) =>
    [
      el.tagName,
      (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      el.getAttribute("data-testid") ?? "",
      el.hasAttribute("disabled") ? "disabled" : "",
      el.getAttribute("href") ?? "",
    ].join(" | "),
  );
}

function nas2Chaves(ui: () => ReactNode) {
  const off = render(
    <Envoltorio>
      <ProvedorDoRedesign ligado={false}>{ui()}</ProvedorDoRedesign>
    </Envoltorio>,
  );
  const desligado = { html: off.container.innerHTML, controles: controles(off.container) };
  cleanup();
  const on = render(
    <Envoltorio>
      <ProvedorDoRedesign ligado>{ui()}</ProvedorDoRedesign>
    </Envoltorio>,
  );
  return { desligado, ligado: on.container, controlesLigado: controles(on.container) };
}

const TELAS: Array<{ nome: string; ui: () => ReactNode; pecas: string[] }> = [
  {
    nome: "Agentes",
    ui: () => <AgentsList initialData={[AGENTE] as never} canWrite />,
    pecas: ["conteudo", "barra", "acoes", "filtros", "cartao-topo", "avatar", "selos", "cartao-rodape"],
  },
  {
    nome: "Conhecimento",
    ui: () => (
      <AcervoClient
        initialSources={[MATERIAL] as never}
        initialChave={CHAVE as never}
        agentes={[{ id: "a-1", nome: "Atendimento de vendas", materiais: ["s-1"] }]}
      />
    ),
    pecas: ["conteudo", "barra", "acoes", "grade-materiais"],
  },
  { nome: "Casos", ui: () => <CaseList />, pecas: ["pilulas"] },
  {
    nome: "Roteadores",
    ui: () => <RoutersClient initialState={{ routers: [ROTEADOR] }} channelSessions={[{ id: "cs-1", name: "WhatsApp Vendas" }] as never} />,
    pecas: [],
  },
  { nome: "Follow-ups", ui: () => <FlowsList initialData={[FLUXO] as never} canWrite surface="followup" />, pecas: [] },
];

describe("onda 4 — IA com a chave LIGADA", () => {
  for (const tela of TELAS) {
    it(`${tela.nome}: mesmos botões e links (rótulo, data-testid, disabled) ligado e desligado`, () => {
      const r = nas2Chaves(tela.ui);
      expect(r.desligado.controles.length).toBeGreaterThan(0);
      expect(r.controlesLigado).toEqual(r.desligado.controles);
      // E o desligado não ganhou marca nenhuma desta onda.
      expect(r.desligado.html).not.toContain("data-rd-ia");
    });

    if (tela.pecas.length > 0) {
      it(`${tela.nome}: as peças do v49 aparecem`, () => {
        const { ligado } = nas2Chaves(tela.ui);
        for (const peca of tela.pecas) {
          expect(ligado.querySelector(`[data-rd-ia="${peca}"]`), peca).not.toBeNull();
        }
      });
    }
  }

  it("Agentes: iniciais em quadradinho e o selo embaixo do nome (não mais ao lado do menu)", () => {
    const { ligado } = nas2Chaves(() => <AgentsList initialData={[AGENTE] as never} canWrite />);
    const avatar = ligado.querySelector('[data-rd-ia="avatar"]');
    expect(avatar?.textContent).toBe("AV");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.getAttribute("data-rd-cor")).toMatch(/^[0-9]$/);
    const selos = ligado.querySelector('[data-rd-ia="selos"]');
    expect(selos?.previousElementSibling?.tagName).toBe("H3");
    expect(selos?.querySelector('[data-slot="badge"]')).not.toBeNull();
    // Um selo só por cartão: o lugar antigo ficou vazio.
    expect(ligado.querySelectorAll('[data-slot="badge"]')).toHaveLength(1);
  });

  it("Agentes: a ação de criar fica na barra, direto, para o CSS subi-la à faixa do título", () => {
    const { ligado } = nas2Chaves(() => <AgentsList initialData={[AGENTE] as never} canWrite />);
    const acoes = ligado.querySelector('[data-rd-ia="conteudo"] > [data-rd-ia="barra"] > [data-rd-ia="acoes"]');
    expect(acoes?.textContent).toContain("Criar novo");
  });

  it("Agentes: sem permissão de escrita não há ação na barra (o CSS não monta a grade)", () => {
    const { ligado } = nas2Chaves(() => <AgentsList initialData={[AGENTE] as never} canWrite={false} />);
    expect(ligado.querySelector('[data-rd-ia="acoes"]')).toBeNull();
  });

  it("Roteadores: o botão de criar é a ação da barra (regra da faixa do título das Automações)", () => {
    const { ligado } = nas2Chaves(
      () => <RoutersClient initialState={{ routers: [ROTEADOR] }} channelSessions={[{ id: "cs-1", name: "WhatsApp Vendas" }] as never} />,
    );
    const botao = ligado.querySelector('[data-rd-automacoes="conteudo"] > [data-rd-automacoes="barra"] > [data-rd-automacoes="acoes"]');
    expect(botao?.textContent).toContain("Novo roteador");
  });

  it("a marca é pura: ligada devolve a peça, desligada undefined; o módulo não importa server-only", () => {
    expect(marcaDaIa(false)("pagina")).toBeUndefined();
    expect(marcaDaIa(true)("pagina")).toBe("pagina");
    const lib = fs.readFileSync(path.join(process.cwd(), "lib/redesign/ia.ts"), "utf8");
    expect(lib).not.toMatch(/"use client"/);
    expect(lib).not.toMatch(/from "@\/lib\/redesign\/chave"/);
  });
});

describe("CSS do redesign da IA: escopado pela chave", () => {
  const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const INICIO = "/* redesign: ia ─";
  const FIM = "/* redesign: ia — fim";
  const ESCOPO = '[data-redesign="ligado"]';

  function bloco(css: string): string {
    const i = css.indexOf(INICIO);
    const f = css.indexOf(FIM);
    if (i < 0 || f < 0 || f < i) throw new Error("marcadores do bloco não encontrados");
    if (css.indexOf(INICIO, i + 1) >= 0) throw new Error("marcador de início repetido");
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
    return out.map((x) => x.replace(/\s+/g, " ").trim());
  }

  function erros(css: string): string[] {
    const e: string[] = [];
    const raiz = postcss.parse(css);
    raiz.walkAtRules((at) => {
      if (at.name !== "media") e.push(`@${at.name} ${at.params} não é permitido no bloco`);
    });
    raiz.walkRules((r) => {
      for (const p of partes(r.selector)) if (!p.startsWith(ESCOPO)) e.push(`seletor sem escopo: ${p}`);
    });
    raiz.walkDecls((d) => {
      if (d.important) e.push(`!important em ${d.prop}`);
      // Só tokens: cor literal não troca entre claro e escuro.
      if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(d.value)) e.push(`cor literal em ${d.prop}: ${d.value}`);
    });
    return e;
  }

  it("o bloco existe e tem regras", () => {
    let regras = 0;
    postcss.parse(bloco(CSS)).walkRules(() => {
      regras++;
    });
    expect(regras).toBeGreaterThan(20);
  });

  it('todo seletor do bloco começa por [data-redesign="ligado"], sem !important nem cor literal', () => {
    expect(erros(bloco(CSS))).toEqual([]);
  });

  it("controle negativo: a régua reprova seletor sem escopo, !important e cor literal", () => {
    expect(erros(`.x { color: red; } ${ESCOPO} .a, .b { color: #fff !important; }`)).toEqual([
      "seletor sem escopo: .x",
      "seletor sem escopo: .b",
      "!important em color",
      "cor literal em color: #fff",
    ]);
  });

  it("a grade da faixa do título só monta quando a barra tem ações (estado vazio e quem não cria ficam como estão)", () => {
    const b = bloco(CSS);
    expect(b).toMatch(/\[data-rd-ia="pagina"\]:has\(> \[data-rd-ia="conteudo"\] > \[data-rd-ia="barra"\] > \[data-rd-ia="acoes"\]\) \{\s*display: grid;/);
    expect(b).toContain("fit-content(");
  });
});
