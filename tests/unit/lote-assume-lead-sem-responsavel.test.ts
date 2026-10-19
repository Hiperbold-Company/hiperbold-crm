/**
 * Mover em LOTE com a regra "quem move um lead sem responsável assume".
 *
 * Contra o Route Handler REAL de `POST /api/v1/leads/bulk` (auth e banco são
 * duplos de fronteira): só os cards SEM responsável e que MUDARAM de etapa
 * ganham dono; os que já têm dono (humano ou agente) não são tocados; com a regra
 * desligada nada acontece.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: vi.fn(() => "razão"),
  buildLeadActivityRow: vi.fn(),
}));

import { POST } from "@/app/api/v1/leads/bulk/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const DESTINO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORIGEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEM_DONO = "44444444-4444-4444-8444-444444444444";
const COM_HUMANO = "44444444-4444-4444-8444-444444444445";
const COM_AGENTE = "44444444-4444-4444-8444-444444444446";
const JA_NA_ETAPA = "44444444-4444-4444-8444-444444444447";

interface Estado {
  ligada: boolean;
  /** `false` = o ator não é membro da organização (suporte da plataforma). */
  membro: boolean;
  /** Os patches do UPDATE condicional de dono, com os ids que ele alcançou. */
  assumidos: Array<{ patch: Record<string, unknown>; ids: string[] }>;
}

function lead(id: string, dono: { u?: string; a?: string } = {}, stage = ORIGEM) {
  return {
    id,
    organization_id: ORG_ID,
    tags: [],
    stage_id: stage,
    pipeline_id: PIPELINE_ID,
    contact_id: null,
    lost_reason: null,
    custom_fields: {},
    won_reason: null,
    status: "open",
    owner_user_id: dono.u ?? null,
    owner_agent_id: dono.a ?? null,
  };
}

const CARDS = [
  lead(SEM_DONO),
  lead(COM_HUMANO, { u: "99999999-9999-4999-8999-999999999999" }),
  lead(COM_AGENTE, { a: "88888888-8888-4888-8888-888888888888" }),
  lead(JA_NA_ETAPA, {}, DESTINO),
];

function cliente(estado: Estado) {
  return {
    from: (tabela: string) => {
      let op: "select" | "update" = "select";
      let patch: Record<string, unknown> = {};
      void estado.membro;
      let ids: string[] = [];
      const exigeSemDono: string[] = [];
      const b = {
        select: () => b,
        update: (p: Record<string, unknown>) => {
          op = "update";
          patch = p;
          return b;
        },
        eq: () => b,
        in: (_c: string, v: string[]) => {
          ids = v;
          return b;
        },
        is: (c: string) => {
          exigeSemDono.push(c);
          return b;
        },
        maybeSingle: async () =>
          tabela === "user_organizations"
            ? { data: estado.membro ? { user_id: USER_ID } : null, error: null }
            : tabela === "organizations"
            ? { data: { settings: { routing: { assign_owner_on_move: estado.ligada } } }, error: null }
            : { data: { id: DESTINO, name: "Destino", is_lost: false, is_won: false, pipeline_id: PIPELINE_ID, organization_id: ORG_ID }, error: null },
        then: (resolve: (v: unknown) => unknown) => {
          if (op === "update" && tabela === "crm_leads" && patch.owner_kind !== undefined) {
            // O `where owner_user_id is null and owner_agent_id is null` do banco.
            const alcancados = CARDS.filter(
              (c) => ids.includes(c.id) && !c.owner_user_id && !c.owner_agent_id,
            ).map((c) => c.id);
            estado.assumidos.push({ patch, ids: alcancados });
            return resolve({ data: alcancados.map((id) => ({ id })), error: null });
          }
          return resolve({ data: tabela === "crm_leads" ? CARDS : [], error: null });
        },
      };
      return b;
    },
    rpc: (nome: string) =>
      Promise.resolve(
        nome === "fn_mover_leads_em_lote"
          ? {
              data: CARDS.map((c) => ({
                lead_id: c.id,
                from_stage_id: c.stage_id,
                pipeline_id: PIPELINE_ID,
              })),
              error: null,
            }
          : { data: null, error: null },
      ),
  };
}

function sessao(estado: Estado) {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" as Role }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "agent" as Role },
  } as never);
  vi.mocked(createClient).mockResolvedValue(cliente(estado) as never);
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }),
    rpc: async () => ({ data: null, error: null }),
  } as never);
}

const pedido = () =>
  new NextRequest("http://local/api/v1/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "move",
      lead_ids: CARDS.map((c) => c.id),
      params: { stage_id: DESTINO },
    }),
  });

const atividadesDeDono = () =>
  vi.mocked(emitLeadActivity).mock.calls.filter((c) => c[1].type === "lead_owner_assumed");

let estado: Estado;
beforeEach(() => {
  vi.clearAllMocks();
  estado = { ligada: true, membro: true, assumidos: [] };
  sessao(estado);
});

describe("mover em lote: quem move um lead sem responsável assume", () => {
  it("ligada: só o card sem responsável e que MUDOU de etapa vira do atendente; os outros ficam como estão", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(200);
    expect(estado.assumidos).toHaveLength(1);
    // A rota só PEDE os que a decisão aprovou: o card que já tem dono, o de agente
    // e o que não mudou de etapa nem entram no UPDATE.
    expect(estado.assumidos[0]!.ids).toEqual([SEM_DONO]);
    expect(estado.assumidos[0]!.patch).toMatchObject({
      owner_user_id: USER_ID,
      owner_agent_id: null,
      owner_kind: "user",
    });
    expect(typeof estado.assumidos[0]!.patch.assigned_at).toBe("string");
    expect(atividadesDeDono().map((c) => c[1].leadId)).toEqual([SEM_DONO]);
  });

  it("desligada (o padrão): ninguém é tocado", async () => {
    estado.ligada = false;
    const res = await POST(pedido());
    expect(res.status).toBe(200);
    expect(estado.assumidos).toHaveLength(0);
    expect(atividadesDeDono()).toHaveLength(0);
  });

  it("suporte da plataforma em acompanhamento (não é membro) não assume ninguém, e o lote anda", async () => {
    estado.membro = false;
    const res = await POST(pedido());
    expect(res.status).toBe(200);
    expect(estado.assumidos).toHaveLength(0);
    expect(atividadesDeDono()).toHaveLength(0);
  });
});
