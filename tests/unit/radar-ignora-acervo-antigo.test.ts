import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { carregaRadarDeRisco, RADAR_MAX_DIAS_PARADO } from "@/lib/leads/radar-de-risco";

import { filtraOr } from "../helpers/filtro-or-postgrest";

/**
 * Negócio parado há mais de `RADAR_MAX_DIAS_PARADO` dias sai do Radar.
 *
 * Na CBEXS, 492 negócios migrados do Kommo, parados há ~900 dias, lotavam o
 * Radar inteiro. E a varredura lê do mais frio para o mais quente até o teto
 * de 500, então esse acervo também tirava a vaga dos negócios recentes, que
 * nem chegavam a ser lidos. O dublê aplica os filtros e honra o `limit`; sem
 * isso, o terceiro caso passaria com o corte em qualquer lugar.
 */

vi.mock("@/lib/agenda/protecao-followup", () => ({
  protecaoAgendaSupabase: async () => new Map(),
}));

const ORG = "org-1";
const AGORA = new Date("2026-10-29T12:00:00.000Z");
const DIA = 86_400_000;
const haDias = (n: number) => new Date(AGORA.getTime() - n * DIA).toISOString();

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => ((linhas = linhas.filter((l) => l[col] === val)), chain),
      is: (col: string, val: unknown) => ((linhas = linhas.filter((l) => (l[col] ?? null) === val)), chain),
      in: (col: string, vals: unknown[]) => ((linhas = linhas.filter((l) => vals.includes(l[col]))), chain),
      or: (expr: string) => ((linhas = filtraOr(linhas, expr)), chain),
      order: (col: string, opts?: { ascending?: boolean }) => {
        const sinal = opts?.ascending === false ? -1 : 1;
        linhas = [...linhas].sort((a, b) => sinal * String(a[col] ?? "").localeCompare(String(b[col] ?? "")));
        return chain;
      },
      limit: (n: number) => ((linhas = linhas.slice(0, n)), chain),
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(res),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

function lead(id: string, lastActivity: string | null, createdAt: string): Linha {
  return {
    id, organization_id: ORG, status: "open", title: id, pipeline_id: "funil", contact_id: null,
    owner_user_id: null, owner_kind: null, owner_agent_id: null, stage_id: null,
    last_activity_at: lastActivity, created_at: createdAt,
  };
}

const base = (leads: Linha[]) =>
  bancoFalso({ crm_pipelines: [{ id: "funil", organization_id: ORG, is_archived: false }], crm_leads: leads, demandas: [] });

describe("radar ignora o acervo parado há muito tempo", () => {
  it("o corte é de 90 dias", () => {
    expect(RADAR_MAX_DIAS_PARADO).toBe(90);
  });

  it("negócio parado há mais de 90 dias sai; o de 30 dias fica", async () => {
    const radar = await carregaRadarDeRisco(
      base([lead("antigo", haDias(899), haDias(1000)), lead("recente", haDias(30), haDias(40))]),
      { organizationId: ORG, now: AGORA },
    );
    expect(radar.items.map((l) => l.id)).toEqual(["recente"]);
  });

  it("sem atividade registrada, vale a data de criação", async () => {
    const radar = await carregaRadarDeRisco(
      base([lead("criado-ha-muito", null, haDias(200)), lead("criado-recente", null, haDias(10))]),
      { organizationId: ORG, now: AGORA },
    );
    expect(radar.items.map((l) => l.id)).toEqual(["criado-recente"]);
  });

  it("o corte mora na CONSULTA: 500 antigos não tiram a vaga do recente", async () => {
    const antigos = Array.from({ length: 500 }, (_, i) => lead(`antigo-${i}`, haDias(800), haDias(900)));
    const radar = await carregaRadarDeRisco(base([...antigos, lead("recente", haDias(20), haDias(25))]), {
      organizationId: ORG,
      now: AGORA,
    });
    expect(radar.items.map((l) => l.id)).toEqual(["recente"]);
  });
});
