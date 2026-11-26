import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";

import { markConversationUnreadHandler } from "./_handler";

/**
 * `markConversationUnreadHandler`: `unread_count_for_assignee = greatest(atual, 1)`.
 * O dublê só casa a linha quando TODO filtro bate — `organization_id` inclusive —,
 * então a conversa de outra organização existe no banco e só não é alcançável.
 */
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

type Linha = Record<string, unknown>;

function clienteFalso(linhas: Linha[], escritaRecusada = false) {
  return {
    from: () => {
      const filtros: Array<[string, unknown]> = [];
      let patch: Linha | null = null;
      const casa = (l: Linha) => filtros.every(([c, v]) => l[c] === v);
      const q = {
        select: () => q,
        update: (v: Linha) => {
          patch = v;
          return q;
        },
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return q;
        },
        maybeSingle: async () => {
          const alvo = linhas.find(casa) ?? null;
          if (patch && escritaRecusada) return { data: null, error: null };
          if (patch && alvo) Object.assign(alvo, patch);
          return { data: alvo, error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const ctx = (org: string) => ({
  organization_id: org,
  actor: { type: "user" as const, id: "u1" },
  requestId: "r1",
  idioma: "pt-BR" as const,
});

describe("markConversationUnreadHandler", () => {
  it("0 vira 1", async () => {
    const linhas = [{ id: "c1", organization_id: ORG_A, unread_count_for_assignee: 0 }];
    const conv = await markConversationUnreadHandler(clienteFalso(linhas), ctx(ORG_A), "c1");
    expect(conv.unread_count_for_assignee).toBe(1);
    expect(linhas[0]?.unread_count_for_assignee).toBe(1);
  });

  it("3 continua 3: o número de não lidas nunca diminui", async () => {
    const linhas = [{ id: "c1", organization_id: ORG_A, unread_count_for_assignee: 3 }];
    const conv = await markConversationUnreadHandler(clienteFalso(linhas), ctx(ORG_A), "c1");
    expect(conv.unread_count_for_assignee).toBe(3);
    expect(linhas[0]?.unread_count_for_assignee).toBe(3);
  });

  it("conversa de outra organização não é alterada e devolve 404", async () => {
    const linhas = [{ id: "c1", organization_id: ORG_B, unread_count_for_assignee: 0 }];
    const falha = await markConversationUnreadHandler(clienteFalso(linhas), ctx(ORG_A), "c1").catch(
      (e: unknown) => e,
    );
    expect(falha).toBeInstanceOf(ApiError);
    expect(falha).toMatchObject({ status: 404 });
    expect(linhas[0]?.unread_count_for_assignee).toBe(0);
  });

  it("escrita recusada pela RLS (0 linhas) não responde feito: 404", async () => {
    const linhas = [{ id: "c1", organization_id: ORG_A, unread_count_for_assignee: 0 }];
    const falha = await markConversationUnreadHandler(clienteFalso(linhas, true), ctx(ORG_A), "c1").catch(
      (e: unknown) => e,
    );
    expect(falha).toBeInstanceOf(ApiError);
    expect(falha).toMatchObject({ status: 404 });
    expect(linhas[0]?.unread_count_for_assignee).toBe(0);
  });
});
