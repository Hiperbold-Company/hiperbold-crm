import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCrmAlerts } from "@/hooks/notifications/useCrmAlerts";
import { liberarEcoLocal, limparEcosLocais, marcarEcoLocal } from "@/lib/kanban/local-echo";
import { entregarAviso } from "@/lib/notifications/deliver";

/**
 * "Lead atribuído a você" é aviso de quem recebeu o negócio de OUTRA pessoa. Quem
 * move um lead sem responsável (com a regra da organização ligada) e o assume é o
 * autor: o toast não pode vir para ele. A ponta do push está em
 * `push-nao-avisa-quem-assumiu-ao-mover.test.ts`.
 */
const ME = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";

let aoMudarLead: (payload: unknown) => void = () => {};
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org" }),
  useUser: () => ({ id: ME, email: "eu@example.com", full_name: "Eu" }),
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (o: { name: string; onChange: (p: unknown) => void }) => {
    if (o.name.startsWith("alerts-leads")) aoMudarLead = o.onChange;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));
vi.mock("@/lib/notifications/deliver", () => ({ entregarAviso: vi.fn() }));

const atribuicao = (dono: string | null, antes: string | null = null) => ({
  new: { id: LEAD, title: "Maria", pipeline_id: "p", owner_user_id: dono, status: "open" },
  old: { owner_user_id: antes, status: "open" },
});

beforeEach(() => {
  vi.clearAllMocks();
  limparEcosLocais();
  renderHook(() => useCrmAlerts());
});
afterEach(limparEcosLocais);

describe("toast 'Lead atribuído a você'", () => {
  it("recebi o negócio de OUTRA pessoa: avisa", () => {
    aoMudarLead(atribuicao(ME));
    expect(entregarAviso).toHaveBeenCalledWith(expect.objectContaining({ kind: "lead_assigned" }));
  });

  it("acabei de mover (e assumir) este negócio: é eco da minha ação, NÃO avisa", () => {
    marcarEcoLocal(LEAD); // o arrasto e o lote marcam o eco antes de a requisição sair
    aoMudarLead(atribuicao(ME));
    expect(entregarAviso).not.toHaveBeenCalled();
  });

  it("a marca vale também logo depois da resposta (a folga do evento atrasado)", () => {
    marcarEcoLocal(LEAD);
    liberarEcoLocal(LEAD);
    aoMudarLead(atribuicao(ME));
    expect(entregarAviso).not.toHaveBeenCalled();
  });

  it("o eco é POR NEGÓCIO: mexer em outro card não silencia a atribuição deste", () => {
    marcarEcoLocal("outro-lead");
    aoMudarLead(atribuicao(ME));
    expect(entregarAviso).toHaveBeenCalledTimes(1);
  });

  it("atribuição para OUTRA pessoa não avisa a mim, com ou sem eco", () => {
    aoMudarLead(atribuicao("99999999-9999-4999-8999-999999999999"));
    expect(entregarAviso).not.toHaveBeenCalled();
  });
});
