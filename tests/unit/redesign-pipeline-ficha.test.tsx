import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { LeadDossier } from "@/components/kanban/LeadDossier";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import type { Lead } from "@/lib/types/leads";

/**
 * Redesign, item B5 (Pipeline): a FICHA do negócio (o cartão aberto). Desligada,
 * nenhum `data-rd-pipeline` no painel; ligada, o painel, o resumo do topo e cada
 * seção levam a marca que o bloco `/* redesign: pipeline *\/` desenha.
 *
 * As bordas dubladas são as mesmas de `components/kanban/LeadDossier.test.tsx`
 * (sessão, rede e as peças de DENTRO das seções); a casca da ficha é a real.
 */

const linhaDoTempo = vi.hoisted(() => ({ itens: [] as Array<{ id: string; type: string }> }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false, support: false }),
  useActiveOrg: () => ({ role: "agent" }),
  // O seletor de etapa do cabeçalho (#3272) lê a régua de mover card.
  usePermission: () => false,
  useFusoDaOrganizacao: () => null,
}));
vi.mock("@/hooks/leads/useLeadTimeline", () => ({
  useLeadTimeline: () => ({
    itens: linhaDoTempo.itens,
    chegouAoVivo: new Set<string>(),
    isLoading: false,
    isError: false,
    realtimeStatus: "connected",
    seguranca: { divergencias: 0 },
  }),
}));

vi.mock("@/components/kanban/ContatoDoNegocio", () => ({
  ContatoDoNegocio: () => <div data-peca="contato" />,
}));
vi.mock("@/components/kanban/LeadFieldsForm", () => ({
  LeadFieldsForm: () => <div data-peca="campos" />,
}));
vi.mock("@/components/kanban/TarefasDoNegocio", () => ({
  TarefasDoNegocio: () => <div data-peca="tarefas" />,
}));
vi.mock("@/components/kanban/PropostasDoNegocio", () => ({ PropostasDoNegocio: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/kanban/ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/kanban/LeadTimeline", () => ({
  LeadTimeline: ({ itens }: { itens: Array<{ id: string; type: string }> }) => (
    <ul data-peca="linha-do-tempo">
      {itens.map((i) => (
        <li key={i.id} data-entrada={i.id} />
      ))}
    </ul>
  ),
}));

// jsdom não implementa `scrollIntoView`, e o atalho "Editar campos" o chama.
window.HTMLElement.prototype.scrollIntoView ??= () => undefined;

const LEAD = {
  id: "lead-1",
  title: "Viagem Rio",
  contact_id: "contato-1",
  contact_phone: "+5521999999999",
  value_cents: 250000,
  currency: "BRL",
  score: null,
  conversa: null,
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_agent: null,
  // O cabeçalho do dossiê mostra "Criado em" (o tipo Lead exige a data).
  created_at: "2026-10-01T12:00:00.000Z",
} as unknown as Lead;

function montar(ligado: boolean | null) {
  const ficha: ReactNode = (
    <LeadDossier
      open
      onOpenChange={() => undefined}
      lead={LEAD}
      pipelineId="funil-1"
      fieldDefs={[]}
      stageName="Novo"
    />
  );
  return render(
    ligado === null ? ficha : <ProvedorDoRedesign ligado={ligado}>{ficha}</ProvedorDoRedesign>,
  );
}

function marcas(): string[] {
  return [...document.querySelectorAll("[data-rd-pipeline]")].map((n) =>
    n.getAttribute("data-rd-pipeline")!,
  );
}

describe("redesign do Pipeline: a ficha do negócio", () => {
  it.each([
    ["sem provedor", null],
    ["chave desligada", false],
  ] as const)("%s: nenhum data-rd-pipeline no painel", (_n, ligado) => {
    const { unmount } = montar(ligado);
    expect(document.querySelectorAll("[data-secao]").length).toBeGreaterThan(0);
    expect(marcas()).toEqual([]);
    unmount();
  });

  it("ligada: painel, resumo e uma marca por seção, na ordem de sempre", () => {
    const { unmount } = montar(true);
    const painel = document.querySelector('[data-rd-pipeline="ficha"]');
    expect(painel?.getAttribute("data-slot")).toBe("sheet-content");
    expect(painel?.querySelector('[data-rd-pipeline="ficha-resumo"]')).not.toBeNull();
    const secoes = [...document.querySelectorAll('[data-rd-pipeline="secao"]')].map((n) =>
      n.getAttribute("data-secao"),
    );
    expect(secoes).toEqual(
      [...document.querySelectorAll("[data-secao]")].map((n) => n.getAttribute("data-secao")),
    );
    expect(secoes.length).toBeGreaterThan(0);
    unmount();
  });
});
