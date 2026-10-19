/**
 * "Quem move um lead sem responsável assume" — o que NÃO pode acontecer, contra a
 * rota REAL `POST /api/v1/leads/[id]/move` (autorização e banco são duplos de
 * fronteira):
 *
 *  - chave de integração (`via: "token"`, ator `api_token`) move e NÃO assume;
 *  - move recusado (422 campos obrigatórios, 409 OCC) NÃO assume — ninguém vira
 *    dono de um negócio que não saiu do lugar;
 *  - erro no UPDATE de dono NÃO derruba o move (200): a etapa já mudou, e o efeito
 *    perdido é contado em vez de desfeito.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as authDualAdmin from "@/lib/api/auth-dual-admin";
import { autorizarAdministracao } from "@/lib/api/auth-dual-admin";
import { createClient } from "@/lib/supabase/server";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/api/auth-dual-admin", async (original) => ({
  ...(await original<typeof authDualAdmin>()),
  autorizarAdministracao: vi.fn(),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const PIPE = "44444444-4444-4444-8444-444444444444";
const ST_A = "55555555-5555-4555-8555-555555555555";
const ST_B = "66666666-6666-4666-8666-666666666666";
const CARREGADO = "2026-09-15T12:00:00.000Z";

interface Cenario {
  settingsDoFunil: unknown;
  /** `null` = a OCC não achou a linha (outra escrita passou na frente). */
  moveGravaLinha: boolean;
  erroNoUpdateDeDono: boolean;
  donosGravados: Array<Record<string, unknown>>;
}

function banco(c: Cenario) {
  const lead = {
    id: LEAD,
    organization_id: ORG,
    pipeline_id: PIPE,
    stage_id: ST_A,
    contact_id: null,
    status: "open",
    updated_at: CARREGADO,
    custom_fields: {},
    won_reason: null,
    owner_user_id: null,
    owner_agent_id: null,
  };
  return {
    from: (tabela: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        update: (valores: Record<string, unknown>) => {
          const escrita: Record<string, unknown> = {
            eq: () => escrita,
            in: () => escrita,
            is: () => escrita,
            select: () => escrita,
            maybeSingle: async () => ({ data: c.moveGravaLinha ? { id: LEAD } : null, error: null }),
            then: (resolve: (v: unknown) => unknown) => {
              if (valores.owner_kind !== undefined) {
                if (c.erroNoUpdateDeDono) return resolve({ data: null, error: { message: "boom" } });
                c.donosGravados.push(valores);
                return resolve({ data: [{ id: LEAD }], error: null });
              }
              return resolve({ data: [], error: null });
            },
          };
          return escrita;
        },
        maybeSingle: async () => {
          if (tabela === "crm_pipelines") return { data: { settings: c.settingsDoFunil }, error: null };
          if (tabela === "crm_stages")
            return { data: { id: ST_B, pipeline_id: PIPE, name: "B", is_won: false, is_lost: false }, error: null };
          if (tabela === "organizations")
            return { data: { settings: { routing: { assign_owner_on_move: true } } }, error: null };
          if (tabela === "user_organizations") return { data: { user_id: USER }, error: null };
          return { data: lead, error: null };
        },
      };
      return chain;
    },
    rpc: vi.fn(() => Promise.resolve({ error: null })),
  };
}

function autoriza(via: "session" | "token", db: unknown) {
  vi.mocked(autorizarAdministracao).mockResolvedValue({
    ok: true,
    via,
    actor: via === "session" ? { type: "user", id: USER, role: "agent" } : { type: "api_token", id: "tok", role: "agent" },
    organizationId: ORG,
    idioma: "pt-BR",
    supabase: db,
    apiTokenId: via === "token" ? "tok" : undefined,
  } as never);
}

async function move(c: Cenario, via: "session" | "token" = "session") {
  const db = banco(c);
  autoriza(via, db);
  vi.mocked(createClient).mockResolvedValue(db as never);
  const { POST } = await import("@/app/api/v1/leads/[id]/move/route");
  return POST(
    new NextRequest(`http://localhost/api/v1/leads/${LEAD}/move`, {
      method: "POST",
      body: JSON.stringify({ stage_id: ST_B, position_in_stage: 1000, expected_updated_at: CARREGADO }),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: LEAD }) },
  );
}

let c: Cenario;
beforeEach(() => {
  vi.clearAllMocks();
  c = { settingsDoFunil: null, moveGravaLinha: true, erroNoUpdateDeDono: false, donosGravados: [] };
});

describe("mover com a regra ligada — o que não atribui", () => {
  it("controle: sessão de membro, move aceito, sem dono: ASSUME (o teste enxerga a escrita)", async () => {
    const res = await move(c);
    expect(res.status).toBe(200);
    expect(c.donosGravados).toHaveLength(1);
  });

  it("chave de integração (via token, ator api_token) move e NÃO assume", async () => {
    const res = await move(c, "token");
    expect(res.status).toBe(200);
    expect(c.donosGravados).toHaveLength(0);
  });

  it("move recusado por campo obrigatório (422) NÃO assume", async () => {
    c.settingsDoFunil = {
      fields: [{ key: "empresa", label: "Empresa", type: "text", obrigatorio_em: { etapas: [ST_B] } }],
    };
    const res = await move(c);
    expect(res.status).toBe(422);
    expect(c.donosGravados).toHaveLength(0);
  });

  it("move recusado por concorrência (409, OCC) NÃO assume", async () => {
    c.moveGravaLinha = false;
    const res = await move(c);
    expect(res.status).toBe(409);
    expect(c.donosGravados).toHaveLength(0);
  });

  it("erro no UPDATE de dono NÃO derruba o move: 200, e a perda é registrada", async () => {
    c.erroNoUpdateDeDono = true;
    const res = await move(c);
    expect(res.status).toBe(200);
    expect(registraFalhaDeAtividade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tipo: "lead_owner_assumed", origem: "leads/[id]/move" }),
    );
  });
});
