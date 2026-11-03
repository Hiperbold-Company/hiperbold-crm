import { describe, expect, it } from "vitest";

import { alterarFluxo, publicarFluxo, type DepsDeFollowup } from "./administracao";

/** Banco mínimo: toda leitura de ponteiro devolve `linha`; escritas são registradas. */
function deps(linha: Record<string, unknown>): { deps: DepsDeFollowup; escritas: unknown[] } {
  const escritas: unknown[] = [];
  const cadeia: Record<string, unknown> = {};
  Object.assign(cadeia, {
    select: () => cadeia,
    eq: () => cadeia,
    neq: () => cadeia,
    maybeSingle: async () => ({ data: linha, error: null }),
    single: async () => ({ data: linha, error: null }),
    update: (p: unknown) => (escritas.push(p), cadeia),
  });
  const cliente = { from: () => cadeia } as unknown as DepsDeFollowup["supabase"];
  return {
    escritas,
    deps: {
      supabase: cliente,
      admin: cliente,
      organizationId: "o1",
      actor: { type: "user", id: "u1" },
      responsavel: "u1",
      requestId: "r1",
    } as unknown as DepsDeFollowup,
  };
}

const GATILHO_DE_RELOGIO = { kind: "stage_change", params: { stage_id: "11111111-1111-4111-8111-111111111111" } };

describe("o ponteiro de automação fica com gatilho manual (B5)", () => {
  it("PATCH com gatilho de relógio numa automação é recusado, sem escrever", async () => {
    const { deps: d, escritas } = deps({ id: "p1", surface: "automacao" });
    await expect(alterarFluxo(d, "p1", { trigger_config: GATILHO_DE_RELOGIO })).rejects.toMatchObject({ status: 422 });
    expect(escritas).toEqual([]);
  });

  it("PATCH manual numa automação passa; gatilho de relógio num follow-up passa", async () => {
    const a = deps({ id: "p1", surface: "automacao" });
    await alterarFluxo(a.deps, "p1", { trigger_config: { kind: "manual" } });
    expect(a.escritas).toHaveLength(1);
    const f = deps({ id: "p2", surface: "followup" });
    await alterarFluxo(f.deps, "p2", { trigger_config: GATILHO_DE_RELOGIO });
    expect(f.escritas).toHaveLength(1);
  });

  it("publicar automação cujo ponteiro tem gatilho de relógio é recusado", async () => {
    const { deps: d } = deps({ id: "p1", surface: "automacao", trigger_config: GATILHO_DE_RELOGIO, draft_graph: null });
    await expect(publicarFluxo(d, "p1")).rejects.toMatchObject({ status: 422, code: "trigger_kind_not_implemented" });
  });
});

describe("publicar automação confere pessoas e fontes contra a organização (C3)", () => {
  const OUTRA_PESSOA = "22222222-2222-4222-8222-222222222222";
  const FONTE = "33333333-3333-4333-8333-333333333333";
  function grafo(): unknown {
    return {
      nodes: [
        {
          id: "t",
          type: "trigger",
          label: "Início",
          position: { x: 0, y: 0 },
          config: {
            triggers: [{ kind: "lead_created", capture_source_ids: [FONTE] }],
            reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
          },
        },
        {
          id: "a",
          type: "crm_action",
          label: "Ação",
          position: { x: 0, y: 100 },
          config: {
            on_error: "continue",
            actions: [
              { type: "set_owner", mode: { m: "user", user_id: OUTRA_PESSOA } },
              { type: "notify", to: [OUTRA_PESSOA], message: "oi" },
            ],
          },
        },
        { id: "f", type: "end", label: "Fim", position: { x: 0, y: 200 }, config: { outcome: "converted" } },
      ],
      edges: [],
    };
  }
  /** Cada tabela responde o que a organização TEM: `membros` e `fontes` controlam o caso. */
  function banco(membros: string[], fontes: string[]): DepsDeFollowup {
    const ponteiro = { id: "p1", surface: "automacao", trigger_config: { kind: "manual" }, draft_graph: grafo() };
    const cliente = {
      from: (tabela: string) => {
        const dados: unknown[] =
          tabela === "user_organizations"
            ? membros.map((user_id) => ({ user_id }))
            : tabela === "webhook_sources"
              ? fontes.map((id) => ({ id }))
              : [];
        const cadeia: Record<string, unknown> = {};
        Object.assign(cadeia, {
          select: () => cadeia,
          eq: () => cadeia,
          neq: () => cadeia,
          in: () => cadeia,
          is: () => cadeia,
          maybeSingle: async () => ({ data: ponteiro, error: null }),
          then: (ok: (v: unknown) => unknown) => ok({ data: dados, error: null }),
        });
        return cadeia;
      },
    } as unknown as DepsDeFollowup["supabase"];
    return {
      supabase: cliente,
      admin: cliente,
      organizationId: "o1",
      actor: { type: "user", id: "u1" },
      responsavel: "u1",
      requestId: "r1",
    } as unknown as DepsDeFollowup;
  }

  it("pessoa que não é membro ativo desta organização: 422", async () => {
    await expect(publicarFluxo(banco([], [FONTE]), "p1")).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/pessoa escolhida/),
    });
  });

  it("fonte de captação de outra organização: 422", async () => {
    await expect(publicarFluxo(banco([OUTRA_PESSOA], []), "p1")).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/fonte de captação/),
    });
  });
});
