import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DossieDoFollowup } from "@/app/app/ai/followups/enrollments/[id]/_components/DossieDoFollowup";
import type { FollowupEnrollmentDossie } from "@/hooks/followup/useFollowupEnrollment";
import { resumoDoNo } from "@/lib/followup/eventos-legiveis";
import type { FlowNode } from "@/lib/followup/graph-schema";

/**
 * A tela de execução de uma AUTOMAÇÃO, como a pessoa a lê.
 *
 * O bloco Fim nasce com `outcome: "exhausted"` (padrão do grafo, que não muda), e
 * o quadro "Onde está agora" mostrava "Desfecho: exhausted" cru, em inglês, e a
 * linha do tempo dizia "esgotou as tentativas" para uma execução que terminou bem.
 * O follow-up segue exatamente como era.
 */

let dossie: FollowupEnrollmentDossie;

vi.mock("@/hooks/followup/useFollowupEnrollment", () => ({
  useFollowupEnrollment: () => ({ data: dossie, isLoading: false, isError: false }),
  useIntervirNoFollowup: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/followup/useFollowupQueue", () => ({
  useCancelFollowupEnrollment: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

const fim: FlowNode = {
  id: "end-1",
  type: "end",
  label: "Fim",
  position: { x: 0, y: 0 },
  config: { outcome: "exhausted" },
};

function montaDossie(lane: "followup" | "automacao"): FollowupEnrollmentDossie {
  const no = resumoDoNo(fim, lane);
  return {
    id: "enr-1",
    status: "completed",
    lane,
    current_node_id: "end-1",
    next_eval_at: null,
    claimed_until: null,
    motor_ocupado: false,
    started_at: "2026-11-02T12:00:00Z",
    completed_at: "2026-11-02T12:01:00Z",
    updated_at: "2026-11-02T12:01:00Z",
    outcome: "exhausted",
    cancel_reason: null,
    last_error: null,
    attempts: 0,
    max_attempts: 5,
    steps_taken: 3,
    contact: { id: "c1", name: "Maria" },
    flow: { pointer_id: "p1", name: "Boas-vindas", version_id: "v1" },
    agent_name: null,
    no_atual: no,
    nos: [no],
    saidas: [],
    eventos: [
      {
        id: "ev-1",
        node_id: "end-1",
        event_type: "flow_completed",
        payload: { outcome: "exhausted" },
        created_at: "2026-11-02T12:01:00Z",
      },
    ],
    eventos_truncados: false,
    plano_de_tempo: null,
    autores: {},
  };
}

describe("tela de execução — desfecho do bloco Fim", () => {
  it("na automação: 'Concluída' e 'terminou', sem esgotar nem palavra crua do enum", () => {
    dossie = montaDossie("automacao");
    const { container } = render(<DossieDoFollowup id="enr-1" canWrite={false} />);

    const quadro = screen.getByTestId("dossie-onde-esta");
    expect(quadro).toHaveTextContent("Desfecho: Concluída");
    expect(screen.getByTestId("dossie-timeline")).toHaveTextContent("Automação concluída");
    expect(screen.getByTestId("dossie-timeline")).toHaveTextContent("terminou");

    const texto = container.textContent ?? "";
    for (const palavra of ["exhausted", "converted", "esgotou", "Esgotado", "converteu"]) {
      expect(texto, `"${palavra}" vazou na tela da automação`).not.toContain(palavra);
    }
  });

  it("no follow-up nada mudou: a linha do tempo segue dizendo que esgotou as tentativas", () => {
    dossie = montaDossie("followup");
    render(<DossieDoFollowup id="enr-1" canWrite={false} />);

    expect(screen.getByTestId("dossie-timeline")).toHaveTextContent("Fluxo concluído");
    expect(screen.getByTestId("dossie-timeline")).toHaveTextContent("esgotou as tentativas");
    expect(screen.getByTestId("dossie-onde-esta")).toHaveTextContent("Desfecho: Esgotado");
  });
});
