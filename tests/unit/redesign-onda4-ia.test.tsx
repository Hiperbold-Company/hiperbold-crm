/**
 * ONDA 4 DO REDESIGN — IA (Agentes, Conhecimento, Casos, Roteadores e
 * Follow-ups) no v49.
 *
 * Retratos da chave DESLIGADA, escritos ANTES da onda 4 contra o código de
 * sempre. A onda pode reagrupar elementos com a chave ligada; com ela
 * desligada, o HTML tem de ser o mesmo, byte a byte.
 */
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
