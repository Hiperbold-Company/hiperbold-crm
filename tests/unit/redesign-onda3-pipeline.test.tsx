/**
 * ONDA 3 DO REDESIGN — Pipeline (cabeçalho do funil) no v49.
 *
 * Desligada: o cabeçalho é o de sempre, provado pelo retrato inteiro.
 * Ligada: as visões (Quadro, Lista, Calendário) vão para o lado do nome do
 * funil, como no v49; as mesmas ações continuam no cabeçalho, só muda a ordem.
 * O cartão (valor na linha do título) é coberto por redesign-pipeline.test.tsx.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import type { Pipeline, Stage } from "@/lib/kanban/types";

const h = vi.hoisted(() => ({ arquivado: false }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/pipelines/p-1",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  useBoard: () => ({
    data: {
      pipeline: { id: "p-1", name: "Pedidos", vocabulary: null, settings: {}, is_archived: h.arquivado },
      stages: [],
      leads: [],
    },
    isLoading: false,
    error: null,
    pulses: [],
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0, ultimaVerificacao: null },
  }),
}));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));
vi.mock("@/components/kanban/ListaDoFunil", () => ({ ListaDoFunil: () => null }));
vi.mock("@/components/kanban/CalendarioDoFunil", () => ({ CalendarioDoFunil: () => null }));
vi.mock("@/components/kanban/KanbanBoard", () => ({ KanbanBoard: () => <div data-testid="quadro" /> }));
vi.mock("@/hooks/kanban/useEventosManuais", () => ({ useEventosManuais: () => undefined }));
vi.mock("@/hooks/auth/AuthProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/auth/AuthProvider")>()),
  useActiveOrg: () => ({ orgId: "org-1", role: "admin" }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const ETAPAS = [{ id: "e-1", name: "Prospecção", position: 0, is_won: false, is_lost: false }] as unknown as Stage[];
const FUNIS = [
  { id: "p-1", name: "Pedidos" },
  { id: "p-2", name: "Vendas" },
] as unknown as Pipeline[];

async function cabecalho(ligado: boolean, funis: Pipeline[] = FUNIS) {
  const { PipelinePageClient } = await import("@/app/app/pipelines/[id]/_client");
  const { container } = render(
    <ProvedorDoRedesign ligado={ligado}>
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Pedidos"
        role="admin"
        funis={funis}
        funilInicial={{ id: "p-1", name: "Pedidos", vocabulary: null, settings: {}, is_archived: h.arquivado } as unknown as Pipeline}
        etapasIniciais={ETAPAS}
      />
    </ProvedorDoRedesign>,
  );
  return container.querySelector("header") as HTMLElement;
}

/** Rótulos dos controles do cabeçalho, na ordem do documento. */
function controles(el: HTMLElement): string[] {
  return [...el.querySelectorAll("button")].map(
    (b) => b.getAttribute("data-testid") ?? b.textContent?.trim() ?? "",
  );
}

afterEach(() => {
  cleanup();
  h.arquivado = false;
});

describe("onda 3 — Pipeline, chave DESLIGADA", () => {
  it.each([
    ["vários funis", FUNIS],
    ["um funil só", FUNIS.slice(0, 1)],
  ] as const)("cabeçalho (%s): HTML idêntico ao de sempre", async (_n, funis) => {
    expect((await cabecalho(false, [...funis])).outerHTML).toMatchSnapshot();
  });
});

describe("onda 3 — Pipeline, chave LIGADA", () => {
  it.each([
    ["vários funis", FUNIS],
    ["um funil só", FUNIS.slice(0, 1)],
  ] as const)("cabeçalho (%s): visões ao lado do nome, e os mesmos controles", async (_n, funis) => {
    const antes = controles(await cabecalho(false, [...funis])).sort();
    cleanup();
    const el = await cabecalho(true, [...funis]);
    expect(controles(el).sort()).toEqual(antes);
    const identidade = el.querySelector('[data-rd-pipeline="identidade"]') as HTMLElement;
    expect(identidade.querySelector('[data-rd-pipeline="visoes"]')).not.toBeNull();
    expect(identidade.querySelector("h1")).not.toBeNull();
    // As ações ficam à direita, fora da identidade.
    expect(identidade.querySelector('[data-testid="densidade-do-quadro"]')).toBeNull();
    expect(identidade.textContent).not.toContain("Novo negócio");
  });

  it("funil arquivado: nada de visões, igual à chave desligada", async () => {
    h.arquivado = true;
    const el = await cabecalho(true);
    expect(el.querySelector('[data-rd-pipeline="visoes"]')).toBeNull();
  });
});
