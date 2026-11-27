/**
 * AS TRÊS LISTAS DA ONDA 1 NO REDESIGN — Planos de tarefa, Chamadas e Histórico
 * de ações. Desligado é a tela de sempre (sem o resumo em cartões); ligado
 * (`ProvedorDoRedesign ligado`) entra o padrão de lista do v49.
 *
 * NÃO prova a aparência: jsdom não pinta.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: apiGet, patch: vi.fn(), post: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...r }: { href: string; children: ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/contacts/useTelefoneExemplo", () => ({ useTelefoneExemplo: () => "+55 11 99999-9999" }));

import { AuditClient } from "@/app/app/audit/_client";
import { CallsClient } from "@/app/app/calls/_client";
import { PlanosDeTarefa } from "@/app/app/tasks/planos/_client";

function envolver(ui: ReactNode, ligado: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const miolo = <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
  return render(ligado ? <ProvedorDoRedesign ligado>{miolo}</ProvedorDoRedesign> : miolo);
}

const PLANOS = {
  data: {
    planos: [
      {
        id: "p1",
        nome: "Proposta enviada",
        descricao: "Acompanhar a proposta",
        passos: [
          { ordem: 1, titulo: "Ligar", descricao: null, vence_em_dias: 1, prioridade: "medium", atribuir_a: "dono_do_lead" },
        ],
      },
    ],
  },
};

const CHAMADAS = {
  data: [
    {
      id: "c1",
      direction: "outbound",
      status: "completed",
      from_number: "+5511000000000",
      to_number: "+5511911112222",
      handled_by: "ai",
      started_at: "2026-11-20T12:00:00Z",
      answered_at: "2026-11-20T12:00:05Z",
      ended_at: "2026-11-20T12:02:00Z",
      duration_seconds: 115,
      transcript: [{ speaker: "customer", text: "Quero agendar", ts: "2026-11-20T12:00:10Z" }],
      contact: { id: "k1", name: "Maria", display_name: null },
    },
  ],
};

const AUDITORIA = {
  data: [
    {
      id: "a1",
      created_at: "2026-11-20T12:00:00Z",
      actor_user_id: "11111111-2222-3333-4444-555555555555",
      actor_api_token_id: null,
      acting_as_platform_admin: false,
      action: "lead.created",
      resource_type: "lead",
      resource_id: "99999999-aaaa-bbbb-cccc-dddddddddddd",
      request_id: "rrrrrrrr",
      metadata: { a: 1 },
      actor_ip: null,
      actor_user_agent: null,
    },
  ],
  meta: { has_more: false },
};

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(async (url: string) => {
    if (url.includes("task-plans")) return PLANOS;
    if (url.includes("/calls")) return CHAMADAS;
    return AUDITORIA;
  });
});
afterEach(cleanup);

const telas: Array<[string, () => ReactNode, string, string[]]> = [
  ["Planos de tarefa", () => <PlanosDeTarefa />, "Proposta enviada", ["Nome", "Tarefas"]],
  ["Chamadas", () => <CallsClient />, "Maria", ["Contato", "Direção", "Status", "Atendido por", "Duração", "Quando"]],
  ["Histórico de ações", () => <AuditClient />, "lead.created", ["Quem", "Ação", "Onde", "Quando"]],
];

describe.each(telas)("%s", (_nome, tela, linha, titulos) => {
  it("desligado: sem o resumo em cartões", async () => {
    envolver(tela(), false);
    await screen.findByText(linha);
    expect(screen.queryByRole("list", { name: /resumo/i })).toBeNull();
  });

  it("ligado: resumo de 3 cartões e tabela com os títulos de coluna", async () => {
    envolver(tela(), true);
    await screen.findByText(linha);
    const resumo = screen.getByRole("list", { name: /resumo/i });
    expect(within(resumo).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByRole("columnheader").map((c) => c.textContent)).toEqual(titulos);
  });

  it("ligado: clicar na linha abre o painel", async () => {
    envolver(tela(), true);
    fireEvent.click(await screen.findByText(linha));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("Histórico de ações ligado mantém os filtros", () => {
  it("tem Tipo de recurso, De e Até", async () => {
    envolver(<AuditClient />, true);
    await screen.findByText("lead.created");
    expect(screen.getByLabelText("Tipo de recurso")).toBeTruthy();
    expect(screen.getByLabelText("De")).toBeTruthy();
    expect(screen.getByLabelText("Até")).toBeTruthy();
  });
});
