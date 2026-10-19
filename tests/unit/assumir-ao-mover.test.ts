import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { assumirAoMover, deveAssumirAoMover, ehMembroDaOrganizacao } from "@/lib/leads/assumir-ao-mover";
import { ACTIVITY_LABELS } from "@/lib/leads/activity-vocabulary";
import {
  atendimentoConfigPatchSchema,
  donoAoMoverLigado,
  mesclarSettingsDeAtendimento,
  routingConfigSchema,
} from "@/lib/schemas/routing";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const PESSOA = { type: "user", id: "11111111-1111-4111-8111-111111111111" };
const base = {
  ligado: true,
  actor: PESSOA,
  membro: true,
  mudouDeEtapa: true,
  dono: { owner_user_id: null, owner_agent_id: null },
};

describe("deveAssumirAoMover — a decisão", () => {
  it("ligada, pessoa, etapa mudou, sem responsável: assume", () => {
    expect(deveAssumirAoMover(base)).toBe(true);
  });

  it("DESLIGADA (o padrão) nunca assume", () => {
    expect(deveAssumirAoMover({ ...base, ligado: false })).toBe(false);
  });

  it.each(["ai_agent", "webhook_source", "api_token", "system", "rule", "cron"])(
    "ator %s (IA, automação, webhook, integração, cron) NUNCA atribui",
    (type) => {
      expect(deveAssumirAoMover({ ...base, actor: { type, id: "x" } })).toBe(false);
    },
  );

  it("quem NÃO é membro da organização (suporte da plataforma) nunca assume, mesmo com papel efetivo", () => {
    expect(deveAssumirAoMover({ ...base, membro: false })).toBe(false);
  });

  it("mesma etapa (reordenar) não assume", () => {
    expect(deveAssumirAoMover({ ...base, mudouDeEtapa: false })).toBe(false);
  });

  it("já tem responsável humano: não toma", () => {
    expect(deveAssumirAoMover({ ...base, dono: { owner_user_id: "u", owner_agent_id: null } })).toBe(false);
  });

  it("de um agente de IA (sem humano) NÃO conta como sem responsável: é o que a tela mostra", () => {
    expect(deveAssumirAoMover({ ...base, dono: { owner_user_id: null, owner_agent_id: "a" } })).toBe(false);
  });

  it("dono ausente no registro (undefined) vale como sem responsável", () => {
    expect(deveAssumirAoMover({ ...base, dono: {} })).toBe(true);
  });
});

describe("a configuração da organização", () => {
  it("nasce DESLIGADA: organização existente (sem a chave) não muda", () => {
    expect(routingConfigSchema.parse({}).assign_owner_on_move).toBe(false);
    expect(donoAoMoverLigado({})).toBe(false);
    expect(donoAoMoverLigado({ routing: {} })).toBe(false);
    expect(donoAoMoverLigado(null)).toBe(false);
  });

  it("só o booleano true liga (texto 'true' não)", () => {
    expect(donoAoMoverLigado({ routing: { assign_owner_on_move: true } })).toBe(true);
    expect(donoAoMoverLigado({ routing: { assign_owner_on_move: "true" } })).toBe(false);
  });

  it("o PATCH da tela grava no routing e um cliente antigo (sem a chave) não a desliga por omissão", () => {
    const ligada = mesclarSettingsDeAtendimento(
      { other: 1 },
      atendimentoConfigPatchSchema.parse({ mode: "manual", assign_owner_on_move: true }),
    );
    expect(donoAoMoverLigado(ligada.settings)).toBe(true);
    expect(ligada.settings.other).toBe(1);

    const antigo = mesclarSettingsDeAtendimento(
      ligada.settings,
      atendimentoConfigPatchSchema.parse({ mode: "round_robin" }),
    );
    expect(donoAoMoverLigado(antigo.settings)).toBe(true);
  });
});

describe("o tipo de atividade", () => {
  it("nunca colapsa na timeline: a troca de responsável não some num bloco '2 ações'", async () => {
    const { agrupaTimeline } = await import("@/lib/leads/timeline-grouping");
    const mk = (id: string, type: string) => ({
      id,
      organization_id: "o",
      lead_id: "l",
      contact_id: null,
      source_module: "crm",
      source_id: null,
      type,
      payload: {},
      metadata: {},
      performed_at: "2026-10-19T12:00:00.000Z",
      performed_by_user_id: "u",
      actor_kind: "user",
    });
    const blocos = agrupaTimeline([mk("1", "lead_owner_assumed"), mk("2", "stage_changed")]);
    expect(blocos[0]).toMatchObject({ tipo: "item" });
  });

  it("tem rótulo próprio em português, sem falar de 'conversa'", () => {
    expect(ACTIVITY_LABELS.lead_owner_assumed).toBe("Assumiu o negócio");
  });
});

/** Banco que aplica o `where owner is null`: a corrida se decide na escrita. */
function bancoComDonos(donos: Record<string, string | null>) {
  const gravados: Array<Record<string, unknown>> = [];
  const atividades: Array<Record<string, unknown>> = [];
  const supabase = {
    from: (tabela: string) => {
      if (tabela === "crm_lead_activities") {
        return {
          insert: async (linha: Record<string, unknown>) => {
            atividades.push(linha);
            return { error: null };
          },
        };
      }
      let ids: string[] = [];
      let patch: Record<string, unknown> = {};
      const b = {
        update: (p: Record<string, unknown>) => {
          patch = p;
          return b;
        },
        in: (_c: string, v: string[]) => {
          ids = v;
          return b;
        },
        eq: () => b,
        is: () => b,
        select: async () => {
          const livres = ids.filter((id) => donos[id] === null);
          for (const id of livres) {
            donos[id] = patch.owner_user_id as string;
            gravados.push({ id, ...patch });
          }
          return { data: livres.map((id) => ({ id })), error: null };
        },
      };
      return b;
    },
    rpc: vi.fn(async () => ({ error: null })),
  };
  return { supabase: supabase as never, gravados, atividades };
}

describe("ehMembroDaOrganizacao", () => {
  const banco = (resposta: { data: unknown; error: unknown }) =>
    ({
      from: () => {
        const c = { select: () => c, eq: () => c, is: () => c, maybeSingle: async () => resposta };
        return c;
      },
    }) as never;
  it("linha ativa = membro; sem linha = não; erro de leitura = não", async () => {
    expect(await ehMembroDaOrganizacao(banco({ data: { user_id: "u" }, error: null }), "o", "u")).toBe(true);
    expect(await ehMembroDaOrganizacao(banco({ data: null, error: null }), "o", "u")).toBe(false);
    expect(await ehMembroDaOrganizacao(banco({ data: { user_id: "u" }, error: { message: "x" } }), "o", "u")).toBe(false);
  });
});

describe("assumirAoMover — a escrita", () => {
  beforeEach(() => vi.clearAllMocks());
  const ORG = "22222222-2222-4222-8222-222222222222";
  const L1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const L2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("grava o trio de posse + assigned_at, a atividade 'assumiu ao mover' e o audit", async () => {
    const { supabase, gravados, atividades } = bancoComDonos({ [L1]: null });
    const r = await assumirAoMover(supabase, {
      organizationId: ORG,
      leadIds: [L1],
      userId: PESSOA.id,
      requestId: "r",
      origem: "teste",
    });
    expect(r).toEqual([L1]);
    expect(gravados[0]).toMatchObject({ owner_user_id: PESSOA.id, owner_agent_id: null, owner_kind: "user" });
    expect(gravados[0]!.assigned_at).toBeTruthy();
    expect(atividades[0]).toMatchObject({
      type: "lead_owner_assumed",
      actor_kind: "user",
      performed_by_user_id: PESSOA.id,
      reason: "Assumiu ao mover o negócio",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "lead.owner_assumed_on_move", resourceId: L1 }),
    );
  });

  it("CORRIDA: dois movendo ao mesmo tempo — só o primeiro vira dono, o segundo não registra nada", async () => {
    const { supabase, atividades } = bancoComDonos({ [L1]: null });
    const a = await assumirAoMover(supabase, {
      organizationId: ORG,
      leadIds: [L1],
      userId: "u-primeiro",
      requestId: "r1",
      origem: "teste",
    });
    const b = await assumirAoMover(supabase, {
      organizationId: ORG,
      leadIds: [L1],
      userId: "u-segundo",
      requestId: "r2",
      origem: "teste",
    });
    expect(a).toEqual([L1]);
    expect(b).toEqual([]);
    expect(atividades).toHaveLength(1);
    expect(atividades[0]!.performed_by_user_id).toBe("u-primeiro");
  });

  it("em lote: só assume os que ainda estavam sem dono", async () => {
    const { supabase, atividades } = bancoComDonos({ [L1]: null, [L2]: "alguem" });
    const r = await assumirAoMover(supabase, {
      organizationId: ORG,
      leadIds: [L1, L2],
      userId: PESSOA.id,
      requestId: "r",
      origem: "teste",
    });
    expect(r).toEqual([L1]);
    expect(atividades).toHaveLength(1);
  });

  it("lista vazia não toca o banco", async () => {
    const { supabase } = bancoComDonos({});
    await expect(
      assumirAoMover(supabase, { organizationId: ORG, leadIds: [], userId: "u", requestId: "r", origem: "t" }),
    ).resolves.toEqual([]);
  });
});
