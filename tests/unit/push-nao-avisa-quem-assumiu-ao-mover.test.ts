import { beforeEach, describe, expect, it, vi } from "vitest";

import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import { enviarPushAoUsuario } from "@/lib/notifications/web_push";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O push "Lead atribuído a você" não vai para quem acabou de assumir o negócio ao
 * movê-lo. A decisão é do consumidor (olha a atividade `lead_owner_assumed` do
 * próprio destinatário na janela), sem mexer no gatilho SQL — que não sabe quem
 * agiu. A ponta do toast: `aviso-de-atribuicao-nao-avisa-o-autor.test.tsx`.
 */
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => true }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushAoUsuario: vi.fn(async () => ({ sent: 1 })),
  enviarPushDaOrg: vi.fn(async () => ({ sent: 0 })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const EU = "11111111-1111-4111-8111-111111111111";
const OUTRO = "44444444-4444-4444-8444-444444444444";

interface Atividade {
  organization_id: string;
  lead_id: string;
  type: string;
  performed_by_user_id: string;
  created_at: string;
}

function banco(atividades: Atividade[], erroNaAtividade = false) {
  return {
    from: (tabela: string) => {
      const filtros: Array<(r: Record<string, unknown>) => boolean> = [];
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          filtros.push((r) => r[c] === v);
          return b;
        },
        gte: (c: string, v: string) => {
          filtros.push((r) => (r[c] as string) >= v);
          return b;
        },
        limit: () => b,
        maybeSingle: async () => ({ data: { title: "Maria", owner_user_id: EU, pipeline_id: "p" } }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve(
            tabela === "crm_lead_activities"
              ? erroNaAtividade
                ? { data: null, error: { message: "boom" } }
                : { data: atividades.filter((a) => filtros.every((f) => f(a as never))), error: null }
              : { data: [], error: null },
          ),
      };
      return b;
    },
  };
}

const evento = {
  id: "e1",
  organization_id: ORG,
  event_type: "lead.assigned",
  entity_kind: "crm_lead",
  entity_id: LEAD,
  payload: { lead_id: LEAD, to_user_id: EU },
  metadata: {},
  consumed_by: [],
  attempts: 0,
};

const ha = (segundos: number) => new Date(Date.now() - segundos * 1000).toISOString();
const assumiu = (quem: string, segundos: number): Atividade => ({
  organization_id: ORG,
  lead_id: LEAD,
  type: "lead_owner_assumed",
  performed_by_user_id: quem,
  created_at: ha(segundos),
});

beforeEach(() => vi.clearAllMocks());

describe("push 'Lead atribuído a você'", () => {
  it("quem acabou de assumir ao mover NÃO recebe", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco([assumiu(EU, 5)]) as never);
    const r = await webPushInboundHandler.handle(evento);
    expect(r).toMatchObject({ status: "skipped", detail: "auto_atribuicao" });
    expect(enviarPushAoUsuario).not.toHaveBeenCalled();
  });

  it("atribuição vinda de OUTRA pessoa (sem atividade de auto-assunção) recebe", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco([]) as never);
    const r = await webPushInboundHandler.handle(evento);
    expect(r.status).toBe("ok");
    expect(enviarPushAoUsuario).toHaveBeenCalledWith(ORG, EU, expect.objectContaining({ title: "Lead atribuído a você" }));
  });

  it("outra pessoa assumiu este negócio ao mover: o destinatário do push (EU) ainda recebe", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco([assumiu(OUTRO, 5)]) as never);
    await webPushInboundHandler.handle(evento);
    expect(enviarPushAoUsuario).toHaveBeenCalledTimes(1);
  });

  it("assunção antiga (fora da janela) não silencia uma atribuição nova", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco([assumiu(EU, 3600)]) as never);
    await webPushInboundHandler.handle(evento);
    expect(enviarPushAoUsuario).toHaveBeenCalledTimes(1);
  });

  it("erro ao consultar a atividade NÃO silencia o aviso (perder um aviso devido é pior)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco([assumiu(EU, 5)], true) as never);
    await webPushInboundHandler.handle(evento);
    expect(enviarPushAoUsuario).toHaveBeenCalledTimes(1);
  });

  it("os outros avisos de lead (ganho/perdido) não passam por esta checagem", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco([assumiu(EU, 5)]) as never);
    await webPushInboundHandler.handle({ ...evento, event_type: "lead.won" });
    expect(enviarPushAoUsuario).toHaveBeenCalledTimes(1);
  });
});
