/**
 * Controles de tela que MOVEM negócio de etapa (ou marcam ganho/perda) seguem
 * `negocios.mover`, e SÓ ela: atribuir/excluir/clonar continuam em
 * `pipeline.move_card` (papel). A rota é quem barra; aqui a tela só esconde.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BulkActionBar } from "@/components/kanban/BulkActionBar";
import { KanbanCard } from "@/components/kanban/KanbanCard";
import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import type { CardInput } from "@/lib/kanban/card-state";
import type { Lead } from "@/lib/types/leads";

const concedidas = vi.hoisted(() => ({ chaves: new Set<string>() }));
const dragDesligado = vi.hoisted(() => ({ valor: undefined as boolean | undefined }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => concedidas.chaves.has(chave),
  useFusoDaOrganizacao: () => "America/Sao_Paulo",
  useUser: () => ({ id: "u1", is_platform_admin: false }),
  useActiveOrg: () => ({ orgId: "o1", role: "agent" }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@hello-pangea/dnd", () => ({
  Draggable: ({
    children,
    isDragDisabled,
  }: {
    children: (p: unknown, s: unknown) => ReactNode;
    isDragDisabled?: boolean;
  }) => {
    dragDesligado.valor = isDragDisabled;
    return children(
      { innerRef: () => undefined, draggableProps: {}, dragHandleProps: {} },
      { isDragging: false },
    );
  },
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: [] }),
}));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({
  MoveToOtherPipelineDialog: () => null,
}));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("@/components/kanban/NextActionSlot", () => ({ NextActionSlot: () => null }));
vi.mock("@/components/kanban/ReactivationSlot", () => ({ ReactivationSlot: () => null }));
vi.mock("@/components/kanban/ConversaSlot", () => ({ ConversaSlot: () => null }));
vi.mock("@/components/kanban/ContatoNoCard", () => ({ ContatoNoCard: () => null }));

const LEAD = {
  id: "l-1",
  title: "Proposta da ACME",
  owner_user_id: null,
  owner_agent_id: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
} as unknown as Lead;

const CARD = {
  id: "l-1",
  title: "Proposta da ACME",
  valueCents: null,
  currency: null,
  owner: { kind: "unassigned", name: null, agentVersion: null },
  stageName: "Novo",
  hoursInStage: 2,
  isCooling: false,
  tags: [],
} as unknown as CardInput;

function comQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  concedidas.chaves = new Set();
  dragDesligado.valor = undefined;
});

describe("KanbanCard — arrastar é negocios.mover", () => {
  it("sem a permissão o card não arrasta", () => {
    concedidas.chaves = new Set(["pipeline.move_card"]);
    comQuery(<KanbanCard card={CARD} lead={LEAD} index={0} pipelineId="p-1" />);
    expect(dragDesligado.valor).toBe(true);
  });

  it("com a permissão o card arrasta", () => {
    concedidas.chaves = new Set(["negocios.mover"]);
    comQuery(<KanbanCard card={CARD} lead={LEAD} index={0} pipelineId="p-1" />);
    expect(dragDesligado.valor).toBe(false);
  });
});

describe("menu do card — ganhar/perder é negocios.mover; atribuir/excluir é pipeline.move_card", () => {
  async function abrir() {
    const user = userEvent.setup();
    comQuery(<KanbanCardActions lead={LEAD} pipelineId="p-1" />);
    await user.click(screen.getByRole("button", { name: "Ações do lead" }));
  }

  it("sem negocios.mover: some ganho/perdido; Responsável e Excluir ficam", async () => {
    concedidas.chaves = new Set(["pipeline.move_card"]);
    await abrir();
    expect(screen.queryByText("Marcar como ganho")).toBeNull();
    expect(screen.queryByText("Marcar como perdido")).toBeNull();
    expect(screen.getByText("Responsável")).toBeTruthy();
    expect(screen.getByText("Excluir")).toBeTruthy();
    expect(screen.getByText("Levar para outro funil")).toBeTruthy();
  });

  it("com negocios.mover e sem pipeline.move_card: ganho/perdido aparecem, atribuir/excluir não", async () => {
    concedidas.chaves = new Set(["negocios.mover"]);
    await abrir();
    expect(screen.getByText("Marcar como ganho")).toBeTruthy();
    expect(screen.getByText("Marcar como perdido")).toBeTruthy();
    expect(screen.queryByText("Responsável")).toBeNull();
    expect(screen.queryByText("Excluir")).toBeNull();
  });
});

describe("barra de seleção — Mover para…", () => {
  const props = {
    selectedIds: ["l-1"],
    stages: [],
    pipelineId: "p-1",
    tagsExistentes: [],
    onClear: () => undefined,
  };

  it("sem negocios.mover o botão some e o resto da barra fica", () => {
    comQuery(<BulkActionBar {...props} />);
    expect(screen.queryByText("Mover para…")).toBeNull();
    expect(screen.getByText("Excluir")).toBeTruthy();
    expect(screen.getByText("Tag…")).toBeTruthy();
  });

  it("com negocios.mover o botão aparece", () => {
    concedidas.chaves = new Set(["negocios.mover"]);
    comQuery(<BulkActionBar {...props} />);
    expect(screen.getByText("Mover para…")).toBeTruthy();
  });
});
