/**
 * D-097: o push de mensagem recebida só vai a quem pode ver a conversa. Desde o merge
 * do upstream (04/11/2026) quem decide é o banco (`fn_can_view_conversation`, via
 * `enviarPushAQuemVeAConversa`): o handler não remonta mais a regra com o dono e o
 * modo lidos aqui. O envio é falso; o que se mede é que o handler NUNCA cai no envio
 * à organização inteira e entrega a conversa certa ao envio filtrado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => true, vapidPublica: () => "pub", vapidSubject: async () => "mailto:x@y" }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Marca" }) }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushDaOrg: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
  enviarPushAoUsuario: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
  enviarPushAQuemVeAConversa: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { enviarPushAQuemVeAConversa, enviarPushDaOrg } from "@/lib/notifications/web_push";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

function banco(linhas: Record<string, Record<string, unknown> | null>) {
  return {
    from(tabela: string) {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
      };
      return q;
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
  };
}

const evento = (payload: Record<string, unknown>): EventRow =>
  ({
    id: "e1",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "m1",
    payload,
    metadata: {},
    consumed_by: [],
    attempts: 0,
  }) as unknown as EventRow;

beforeEach(() => {
  vi.mocked(enviarPushDaOrg).mockClear();
  vi.mocked(enviarPushAQuemVeAConversa).mockClear();
});

describe("push de mensagem recebida × visibilidade", () => {
  it("envia pelo filtro de quem vê a conversa, nunca à organização inteira", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({
        conversations: { assigned_to_user_id: "dono-1" },
        organizations: { settings: { visibility_mode: "own" } },
      }) as never,
    );
    await webPushInboundHandler.handle(evento({ conversation_id: CONVERSA, body_preview: "oi", type: "text" }));
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
    expect(enviarPushAQuemVeAConversa).toHaveBeenCalledTimes(1);
    const [org, conversa] = vi.mocked(enviarPushAQuemVeAConversa).mock.calls[0]!;
    expect([org, conversa]).toEqual([ORG, CONVERSA]);
  });

  it("conversa que não se acha também passa pelo filtro do banco (nunca vai a todos)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ organizations: { settings: {} } }) as never);
    await webPushInboundHandler.handle(evento({ conversation_id: CONVERSA, body_preview: "oi", type: "text" }));
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
    expect(vi.mocked(enviarPushAQuemVeAConversa).mock.calls[0]!.slice(0, 2)).toEqual([ORG, CONVERSA]);
  });
});
