/**
 * ONDA 4 DO REDESIGN — Automações (lista e editor) no v49.
 *
 * Retratos da chave DESLIGADA, escritos ANTES da onda 4, contra o código de
 * sempre: a onda pode acrescentar e reagrupar ELEMENTOS com a chave ligada,
 * então "sem atributo" não basta para provar que a tela de sempre não mudou.
 * Qualquer diferença no HTML desligado reprova aqui.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FollowupFlowDetailRow } from "@/hooks/followup/useFollowupFlow";
import type { FlowGraph } from "@/lib/followup/graph-schema";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/automacoes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useFusoDaOrganizacao: () => "America/Sao_Paulo",
  useActiveOrg: () => ({ orgId: "org-1", name: "Loja", role: "admin" }),
  useAuth: () => ({ user: { id: "u-1" }, activeOrg: { orgId: "org-1", role: "admin" } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/followup/useFollowupFlow", () => {
  const mutacao = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useDeleteFollowupFlow: mutacao,
    useDisableFollowupFlow: mutacao,
    usePublishFollowupFlow: mutacao,
    useRenameFollowupFlow: mutacao,
    useRollbackFollowupFlow: mutacao,
    useSaveFollowupFlowDraft: mutacao,
    useUpdateHandoffPolicy: mutacao,
  };
});
vi.mock("@/components/fluxos/editor/TriggerConfigControl", () => ({ TriggerConfigControl: () => null }));

import { AutomacoesList } from "@/app/app/automacoes/_components/AutomacoesList";
import { NodePalette } from "@/components/fluxos/editor/NodePalette";
import { PublishBar } from "@/components/fluxos/editor/PublishBar";

function Envoltorio({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const AUTOMACAO = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Novo lead do Facebook",
  status: "active",
  active_version_id: "v1",
  handoff_policy: "pause",
  updated_at: "2026-11-18T12:00:00Z",
};
const RASCUNHO = { ...AUTOMACAO, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Proposta enviada", status: "draft", active_version_id: null };

const FLUXO: FollowupFlowDetailRow = {
  id: "fluxo-1",
  name: "Boas-vindas",
  status: "draft",
  active_version_id: null,
  draft_graph: null,
  handoff_policy: "pause",
  trigger_config: {},
  surface: "automacao",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  versions_count: 1,
  previous_version_id: null,
};
const GRAFO: FlowGraph = { nodes: [], edges: [] };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("onda 4 — retrato da chave DESLIGADA", () => {
  it("lista de Automações: automação, rascunho, follow-up e regra antiga", () => {
    const { container } = render(
      <Envoltorio>
        <AutomacoesList
          initialData={[AUTOMACAO, RASCUNHO] as never}
          followups={[{ id: "f1", name: "Reengajar", status: "draft", surface: "followup", updated_at: "2026-11-17T12:00:00Z" }] as never}
          regras={[
            {
              id: "r1",
              name: "Aviso de negócio ganho",
              is_active: true,
              last_run_at: "2026-11-20T15:00:00Z",
              updated_at: "2026-11-01T12:00:00Z",
              migrated_to_pointer_id: null,
              conversivel: true,
            },
          ]}
          ultimasExecucoes={{ [AUTOMACAO.id]: "2026-11-23T13:00:00Z" } as never}
        />
      </Envoltorio>,
    );
    expect(container.innerHTML).toMatchSnapshot();
  });

  const ESTADOS: [string, Partial<FollowupFlowDetailRow>, boolean][] = [
    ["rascunho limpo", {}, false],
    ["rascunho com alteração", {}, true],
    ["ativa com versão anterior", { status: "active", active_version_id: "v2", previous_version_id: "v1", versions_count: 2 }, false],
    ["desativada", { status: "disabled", active_version_id: "v1", versions_count: 1 }, false],
  ];
  for (const surface of ["automacao", "followup"] as const) {
    for (const [nome, extra, dirty] of ESTADOS) {
      it(`barra do editor (${surface}, ${nome})`, () => {
        const { container } = render(
          <Envoltorio>
            <PublishBar
              flowId="fluxo-1"
              flow={{ ...FLUXO, surface, ...extra }}
              graph={GRAFO}
              dirty={dirty}
              selection={null}
              onDeleteSelection={() => {}}
              onSaved={() => {}}
              onPublishErrors={() => {}}
              onPublishSuccess={() => {}}
              onAutoFit={() => {}}
              canAutoFit
            />
          </Envoltorio>,
        );
        expect(container.innerHTML).toMatchSnapshot();
      });
    }
  }

  for (const surface of ["automacao", "followup"] as const) {
    it(`paleta do editor (${surface})`, () => {
      const { container } = render(
        <Envoltorio>
          <NodePalette onAdd={() => {}} surface={surface} />
        </Envoltorio>,
      );
      expect(container.innerHTML).toMatchSnapshot();
    });
  }
});
