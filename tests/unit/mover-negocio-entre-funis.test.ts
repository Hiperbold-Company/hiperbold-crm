/**
 * Mover o MESMO negócio para uma etapa de outro funil (migration 1013).
 *
 * Três camadas, cada uma no lugar onde ela é verdade:
 *  - a parte decidível (`lib/leads/mover-para-outro-funil.ts`): quais campos
 *    ficam fora do schema do funil de destino — listados, nunca apagados;
 *  - a escolha do bloco `move_deal` (`lib/automacoes/efeitos/mover-negocio.ts`);
 *  - o handler (`moverParaOutroFunilHandler`) contra um banco em memória: a
 *    organização vem do ctx, etapa de outra organização é recusada ANTES de
 *    qualquer escrita, a RPC não recebe `custom_fields` (não tem como apagá-los),
 *    e o evento `lead.stage_changed` sai com o funil de DESTINO.
 *
 * O que só o Postgres prova (a trava do UPDATE solto, o isolamento entre duas
 * organizações dentro da função, id/contato/responsável intactos) está em
 * `tests/invariants/mover-negocio-entre-funis.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";

const auditado: Array<Record<string, unknown>> = [];
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (linha: Record<string, unknown>) => {
    auditado.push(linha);
  }),
  isServiceRoleConfigured: vi.fn(() => false),
}));

type Linha = Record<string, unknown>;
interface Banco {
  tabelas: Record<string, Linha[]>;
  rpcs: Array<{ nome: string; args: Record<string, unknown> }>;
}
let banco: Banco;

/** Um query builder mínimo do supabase-js: select/eq/in/order/limit/maybeSingle/insert. */
function fakeClient() {
  return {
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      let ordem: { col: string; asc: boolean } | null = null;
      let limite: number | null = null;
      const linhas = () => {
        let r = (banco.tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (ordem) {
          const { col, asc } = ordem;
          r = [...r].sort((a, b) => (Number(a[col]) - Number(b[col])) * (asc ? 1 : -1));
        }
        if (limite !== null) r = r.slice(0, limite);
        // Cópias, como o PostgREST: a linha lida não muda quando o banco muda depois.
        return r.map((l) => structuredClone(l));
      };
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          filtros.push((l) => l[col] === v);
          return q;
        },
        in: (col: string, vs: unknown[]) => {
          filtros.push((l) => vs.includes(l[col]));
          return q;
        },
        order: (col: string, o: { ascending: boolean }) => {
          ordem = { col, asc: o.ascending };
          return q;
        },
        limit: (n: number) => {
          limite = n;
          return q;
        },
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        insert: async (row: Linha) => {
          (banco.tabelas[tabela] ??= []).push(row);
          return { error: null };
        },
        then: (ok: (v: { data: Linha[]; error: null }) => unknown) => Promise.resolve({ data: linhas(), error: null }).then(ok),
      };
      return q;
    },
    async rpc(nome: string, args: Record<string, unknown>) {
      banco.rpcs.push({ nome, args });
      if (nome === "fn_mover_negocio_para_outro_funil") {
        // O suficiente para a releitura: a regra de verdade é do banco (invariante).
        const lead = banco.tabelas.crm_leads!.find((l) => l.id === args.p_lead_id)!;
        const etapa = banco.tabelas.crm_stages!.find((s) => s.id === args.p_stage_id)!;
        Object.assign(lead, { pipeline_id: etapa.pipeline_id, stage_id: etapa.id, position_in_stage: args.p_position_in_stage });
      }
      return { data: null, error: null };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient() }));

import { moverParaOutroFunilHandler } from "@/app/api/v1/leads/_handler";
import { escolherNegocioParaMover } from "@/lib/automacoes/efeitos/mover-negocio";
import type { FatosDaAutomacao } from "@/lib/automacoes/fatos";
import { camposForaDoFunilDeDestino } from "@/lib/leads/mover-para-outro-funil";

const ORG = "10130000-0000-4000-8000-000000000001";
const OUTRA_ORG = "10130000-0000-4000-8000-000000000002";
const LEAD = "10130000-0000-4000-8000-0000000000a1";
const CONTATO = "10130000-0000-4000-8000-0000000000c1";
const DONO = "10130000-0000-4000-8000-0000000000d1";
const FUNIL_A = "10130000-0000-4000-8000-0000000000f1";
const FUNIL_B = "10130000-0000-4000-8000-0000000000f2";
const FUNIL_X = "10130000-0000-4000-8000-0000000000f9";
const ETAPA_A = "10130000-0000-4000-8000-0000000000e1";
const ETAPA_B = "10130000-0000-4000-8000-0000000000e2";
const ETAPA_X = "10130000-0000-4000-8000-0000000000e9";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "webhook_source", id: "automacao-1" } as HandlerCtx["actor"],
  requestId: "automacao:p1:e1",
  idioma: "pt-BR",
  serviceOrigin: { kind: "command", observed: {} },
};

beforeEach(() => {
  auditado.length = 0;
  banco = {
    rpcs: [],
    tabelas: {
      crm_leads: [
        {
          id: LEAD,
          organization_id: ORG,
          pipeline_id: FUNIL_A,
          stage_id: ETAPA_A,
          status: "open",
          contact_id: CONTATO,
          owner_user_id: DONO,
          custom_fields: { cpf: "123", origem_kommo: "site", vazio: "", lista: [] },
          updated_at: "2026-11-14T10:00:00.000Z",
        },
        { id: "outro", organization_id: ORG, pipeline_id: FUNIL_B, stage_id: ETAPA_B, position_in_stage: 500 },
      ],
      crm_stages: [
        { id: ETAPA_A, organization_id: ORG, pipeline_id: FUNIL_A, name: "Novo", is_won: false, is_lost: false, is_archived: false },
        { id: ETAPA_B, organization_id: ORG, pipeline_id: FUNIL_B, name: "Triagem", is_won: false, is_lost: false, is_archived: false },
        { id: ETAPA_X, organization_id: OUTRA_ORG, pipeline_id: FUNIL_X, name: "Alheia", is_won: false, is_lost: false, is_archived: false },
      ],
      crm_pipelines: [
        { id: FUNIL_A, organization_id: ORG, name: "Vendas", is_archived: false, settings: { fields: [{ key: "cpf", label: "CPF", type: "text" }, { key: "origem_kommo", label: "Origem", type: "text" }] } },
        { id: FUNIL_B, organization_id: ORG, name: "Pós-venda", is_archived: false, settings: { fields: [{ key: "cpf", label: "CPF", type: "text" }] } },
        { id: FUNIL_X, organization_id: OUTRA_ORG, name: "Outra empresa", is_archived: false, settings: { fields: [] } },
      ],
      contacts: [{ id: CONTATO, organization_id: ORG, is_personal: false }],
      crm_lead_activities: [],
    },
  };
});

async function recusa(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("esperava recusa");
}

describe("campos personalizados fora do schema do funil de destino", () => {
  it("lista só as chaves preenchidas que o destino não declara, sem tocar no objeto", () => {
    const campos = { cpf: "1", origem_kommo: "site", nota: 0, vazio: " ", lista: [], nulo: null };
    const copia = structuredClone(campos);
    expect(camposForaDoFunilDeDestino(campos, { fields: [{ key: "cpf", label: "CPF", type: "text" }] })).toEqual([
      "nota",
      "origem_kommo",
    ]);
    expect(campos).toEqual(copia);
  });

  it("funil sem schema: todo campo preenchido fica listado; sem campos, lista vazia", () => {
    expect(camposForaDoFunilDeDestino({ a: 1 }, null)).toEqual(["a"]);
    expect(camposForaDoFunilDeDestino(null, { fields: [] })).toEqual([]);
  });
});

describe("move_deal: qual negócio se move", () => {
  const fatos = (vars: Record<string, unknown>, negocio: { id: string; pipeline_id: string } | null, negocios: FatosDaAutomacao["negocios"]) =>
    ({ contato: null, negocio, negocios, vars }) as unknown as FatosDaAutomacao;

  it("o negócio da execução vai para o outro funil, mesmo com aberto do contato no destino", () => {
    const f = fatos({ _lead_id: "n1" }, { id: "n1", pipeline_id: FUNIL_A }, [
      { id: "n1", pipeline_id: FUNIL_A, stage_id: ETAPA_A, status: "open" },
      { id: "n2", pipeline_id: FUNIL_B, stage_id: ETAPA_B, status: "open" },
    ]);
    expect(escolherNegocioParaMover({ fatos: f }, FUNIL_B)).toEqual({ id: "n1", entreFunis: true });
  });

  it("negócio da execução já no funil de destino: troca de etapa comum", () => {
    const f = fatos({ _lead_id: "n2" }, { id: "n2", pipeline_id: FUNIL_B }, [{ id: "n2", pipeline_id: FUNIL_B, stage_id: ETAPA_B, status: "open" }]);
    expect(escolherNegocioParaMover({ fatos: f }, FUNIL_B)).toEqual({ id: "n2", entreFunis: false });
  });

  it("sem negócio na execução: o aberto do contato no destino troca de etapa (como antes)", () => {
    const f = fatos({}, { id: "n1", pipeline_id: FUNIL_A }, [
      { id: "n1", pipeline_id: FUNIL_A, stage_id: ETAPA_A, status: "open" },
      { id: "n2", pipeline_id: FUNIL_B, stage_id: ETAPA_B, status: "open" },
    ]);
    expect(escolherNegocioParaMover({ fatos: f }, FUNIL_B)).toEqual({ id: "n2", entreFunis: false });
  });

  it("sem negócio na execução e nada no destino: o aberto mais recente troca de funil; nenhum = null", () => {
    const f = fatos({}, { id: "n1", pipeline_id: FUNIL_A }, [{ id: "n1", pipeline_id: FUNIL_A, stage_id: ETAPA_A, status: "open" }]);
    expect(escolherNegocioParaMover({ fatos: f }, FUNIL_B)).toEqual({ id: "n1", entreFunis: true });
    expect(escolherNegocioParaMover({ fatos: fatos({}, null, []) }, FUNIL_B)).toBeNull();
  });
});

describe("moverParaOutroFunilHandler", () => {
  it("move o MESMO negócio: id, contato e responsável ficam; campos fora do destino preservados e listados", async () => {
    const r = await moverParaOutroFunilHandler(fakeClient() as never, ctx, LEAD, { to_stage_id: ETAPA_B });

    expect(r).toMatchObject({ id: LEAD, pipeline_id: FUNIL_B, stage_id: ETAPA_B, contact_id: CONTATO, owner_user_id: DONO });
    expect(r.custom_fields).toEqual({ cpf: "123", origem_kommo: "site", vazio: "", lista: [] });

    const mover = banco.rpcs.find((c) => c.nome === "fn_mover_negocio_para_outro_funil")!;
    expect(mover.args).toEqual({
      p_organization_id: ORG,
      p_lead_id: LEAD,
      p_stage_id: ETAPA_B,
      // topo da etapa: a primeira posição (500) menos um passo
      p_position_in_stage: -500,
      p_expected_updated_at: "2026-11-14T10:00:00.000Z",
    });

    const evento = banco.rpcs.find((c) => c.nome === "emit_event")!;
    expect(evento.args.p_event_type).toBe("lead.stage_changed");
    expect(evento.args.p_payload).toMatchObject({
      pipeline_id: FUNIL_B,
      from_pipeline_id: FUNIL_A,
      from_stage_id: ETAPA_A,
      to_stage_id: ETAPA_B,
      troca_de_funil: true,
    });
    expect(evento.args.p_organization_id).toBe(ORG);

    const atividade = banco.tabelas.crm_lead_activities![0]!;
    expect(atividade).toMatchObject({ organization_id: ORG, lead_id: LEAD, type: "stage_changed" });
    expect(atividade.payload).toMatchObject({
      from_pipeline_id: FUNIL_A,
      to_pipeline_id: FUNIL_B,
      campos_fora_do_funil: ["origem_kommo"],
    });
    expect(String(atividade.reason)).toBe("Movido do funil Vendas › Novo para o funil Pós-venda › Triagem");

    expect(auditado).toHaveLength(1);
    expect(auditado[0]).toMatchObject({
      action: "lead.pipeline_moved",
      organizationId: ORG,
      resourceId: LEAD,
      metadata: expect.objectContaining({ from_pipeline_id: FUNIL_A, to_pipeline_id: FUNIL_B, campos_fora_do_funil: ["origem_kommo"] }),
    });
  });

  it("etapa de OUTRA organização: 404 e nenhuma escrita", async () => {
    const err = await recusa(() => moverParaOutroFunilHandler(fakeClient() as never, ctx, LEAD, { to_stage_id: ETAPA_X }));
    expect(err.status).toBe(404);
    expect(banco.rpcs).toHaveLength(0);
    expect(banco.tabelas.crm_leads![0]).toMatchObject({ pipeline_id: FUNIL_A, stage_id: ETAPA_A });
  });

  it("negócio de outra organização (ctx de outra empresa): 404", async () => {
    const err = await recusa(() =>
      moverParaOutroFunilHandler(fakeClient() as never, { ...ctx, organization_id: OUTRA_ORG }, LEAD, { to_stage_id: ETAPA_X }),
    );
    expect(err.status).toBe(404);
    expect(banco.rpcs).toHaveLength(0);
  });

  it("etapa do MESMO funil não é troca de funil: 422 apontando a troca de etapa", async () => {
    const err = await recusa(() => moverParaOutroFunilHandler(fakeClient() as never, ctx, LEAD, { to_stage_id: ETAPA_A }));
    expect(err.status).toBe(422);
    expect(err.details).toMatchObject({ use: "/api/v1/leads/{id}/move" });
    expect(banco.rpcs).toHaveLength(0);
  });

  it("funil de destino arquivado: 422 e nenhuma escrita", async () => {
    banco.tabelas.crm_pipelines![1]!.is_archived = true;
    const err = await recusa(() => moverParaOutroFunilHandler(fakeClient() as never, ctx, LEAD, { to_stage_id: ETAPA_B }));
    expect(err.status).toBe(422);
    expect(banco.rpcs).toHaveLength(0);
  });
});
