import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CalendarioDeTarefas } from "@/app/app/tasks/_components/CalendarioDeTarefas";
import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { PlanosDeTarefa } from "@/app/app/tasks/planos/_client";
import { AgentCard } from "@/app/app/ai/agents/_components/AgentCard";
import { AgentOperation } from "@/app/app/ai/agents/[id]/_components/AgentOperation";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";
import type { Tarefa } from "@/lib/tarefas/tipos";

/**
 * Redesign (Tarefas: formulário, calendário, editor de planos; Agentes: tipo e
 * detalhe): desligado, nenhuma marca nas peças novas; ligado, elas aparecem.
 */
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u-1" }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [], isSuccess: true }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: { planos: [] } })), patch: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/app/app/ai/agents/_components/AgentRowMenu", () => ({ AgentRowMenu: () => null }));

const TAREFA = {
  id: "t-1",
  title: "Ligar de volta",
  description: null,
  priority: "high",
  status: "pending",
  due_date: new Date().toISOString(),
  assigned_to: null,
} as unknown as Tarefa;

const AGENTE = {
  id: "a-1",
  name: "Luna",
  description: null,
  kind: "mcp_agent",
  priority: 1,
  is_default: false,
  model: "claude-sonnet-4-6",
  versao_publicada: null,
  versoes_rascunho: [],
  operation_mode: "automatic",
  paused_at: null,
  published_version_id: null,
} as unknown as AgentRow;

function montar(ligado: boolean, ui: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProvedorDoRedesign ligado={ligado}>{ui}</ProvedorDoRedesign>
    </QueryClientProvider>,
  );
}

function pecas(raiz: ParentNode, atributo: string): string[] {
  return Array.from(raiz.querySelectorAll(`[${atributo}]`)).map((e) => e.getAttribute(atributo) ?? "");
}

async function abrirNovoPlano() {
  const botao = await screen.findByRole("button", { name: "Novo plano" });
  await waitFor(() => expect((botao as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(botao);
  await screen.findByLabelText("Nome do plano");
}

const TAREFAS_UI = (
  <>
    <CalendarioDeTarefas tarefas={[TAREFA]} podeEditar aoAbrirTarefa={vi.fn()} aoClicarNoDia={vi.fn()} />
    <FormularioDeTarefa aberto aoMudarAbertura={vi.fn()} aoSalvar={vi.fn()} />
  </>
);
const AGENTES_UI = (
  <>
    <AgentCard agent={AGENTE} canWrite={false} />
    <AgentOperation agent={AGENTE} />
  </>
);

describe("redesign: peças novas de Tarefas, Planos e Agentes", () => {
  it("desligado: nenhuma marca no calendário, no formulário nem nos agentes", () => {
    montar(false, TAREFAS_UI);
    expect(pecas(document.body, "data-rd-inicio")).toHaveLength(0);
    montar(false, AGENTES_UI);
    expect(pecas(document.body, "data-rd-metricas")).toHaveLength(0);
  });

  it("ligado: calendário e formulário (diálogo) levam a marca", () => {
    montar(true, TAREFAS_UI);
    const p = pecas(document.body, "data-rd-inicio");
    for (const peca of ["tarefas-calendario", "tarefas-calendario-dia", "tarefas-formulario"]) {
      expect(p).toContain(peca);
    }
  });

  it("desligado: o tipo do agente segue cru, como hoje", () => {
    const { container } = montar(false, AGENTES_UI);
    expect(container.textContent).toContain("mcp_agent");
  });

  it("ligado: o tipo do agente e a operação levam a marca; o tipo vira rótulo legível", () => {
    const { container } = montar(true, AGENTES_UI);
    const p = pecas(container, "data-rd-metricas");
    expect(p).toContain("agentes-tipo");
    expect(p).toContain("agente-operacao");
    expect(container.querySelector('[data-rd-metricas="agentes-tipo"]')?.textContent?.trim()).toBe("Agente com ferramentas");
  });

  it("o editor de planos: sem marca desligado; com marca ligado", async () => {
    const off = montar(false, <PlanosDeTarefa />);
    await abrirNovoPlano();
    expect(off.container.querySelector("#plano-nome")).not.toBeNull();
    expect(pecas(off.container, "data-rd-inicio")).toHaveLength(0);
    off.unmount();

    const on = montar(true, <PlanosDeTarefa />);
    await abrirNovoPlano();
    const p = pecas(on.container, "data-rd-inicio");
    expect(p).toContain("planos-editor");
    expect(p).toContain("planos-passo");
  });
});
