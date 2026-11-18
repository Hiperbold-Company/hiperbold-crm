import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { conexaoPadraoDoSeletor, type ConexaoResumo } from "@/lib/inbox/conexao-ao-abrir";
import { carregarOpcoesDeAbertura } from "@/lib/inbox/opcoes-de-abertura";
import { CHANNEL_PROVIDER_META_SOCIAL, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

/**
 * O seletor de conexão do painel do negócio (pedido do dono do produto, 18/11/2026): vem marcado
 * com a conexão de que o usuário logado é o MEMBRO RESPONSÁVEL (migration 1019). Com várias, a
 * primeira conectada na ordem de criação; sem nenhuma, "Automático" (a regra de sempre).
 */

const c = (id: string, conectada = true): ConexaoResumo => ({ id, nome: id, conectada });

describe("conexaoPadraoDoSeletor — a regra do padrão", () => {
  it("sem conexão vinculada a mim: null (fica em Automático, comportamento de antes)", () => {
    expect(conexaoPadraoDoSeletor({ conexoes_do_seletor: [c("a"), c("b")], vinculadas_a_mim_ids: [] })).toBeNull();
  });

  it("resposta antiga, sem os campos novos: null", () => {
    expect(conexaoPadraoDoSeletor({})).toBeNull();
  });

  it("uma vinculada: é ela, mesmo desconectada", () => {
    expect(
      conexaoPadraoDoSeletor({ conexoes_do_seletor: [c("a"), c("b", false)], vinculadas_a_mim_ids: ["b"] }),
    ).toEqual(c("b", false));
  });

  it("várias vinculadas: a primeira CONECTADA na ordem da lista", () => {
    expect(
      conexaoPadraoDoSeletor({
        conexoes_do_seletor: [c("a", false), c("b"), c("c")],
        vinculadas_a_mim_ids: ["c", "a", "b"],
      }),
    ).toEqual(c("b"));
  });

  it("várias vinculadas, nenhuma conectada: a primeira da lista", () => {
    expect(
      conexaoPadraoDoSeletor({
        conexoes_do_seletor: [c("a"), c("b", false), c("c", false)],
        vinculadas_a_mim_ids: ["c", "b"],
      }),
    ).toEqual(c("b", false));
  });

  it("vinculada que não está no seletor (não posso usar) nunca vira padrão", () => {
    expect(conexaoPadraoDoSeletor({ conexoes_do_seletor: [c("a")], vinculadas_a_mim_ids: ["fora"] })).toBeNull();
  });
});

// ─── a leitura, sobre um banco em memória que aplica os filtros ─────────────

type Linha = Record<string, unknown>;

function bancoEmMemoria(tabelas: Record<string, Linha[]>): SupabaseClient {
  function consulta(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const b = {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (col: string, v: unknown) => {
        filtros.push((l) => l[col] === v);
        return b;
      },
      in: (col: string, vs: unknown[]) => {
        filtros.push((l) => vs.includes(l[col]));
        return b;
      },
      is: (col: string, v: unknown) => {
        filtros.push((l) => (l[col] ?? null) === v);
        return b;
      },
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) => ok({ data: linhas(), error: null }),
    };
    return b;
  }
  return { from: consulta } as unknown as SupabaseClient;
}

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA_ORG = "00000000-0000-4000-8000-00000000000b";
const INGRID = "00000000-0000-4000-8000-000000000002";
const ROSANA = "00000000-0000-4000-8000-000000000001";
const S_GERAL = "00000000-0000-4000-8000-000000000201";
const S_INGRID_1 = "00000000-0000-4000-8000-000000000202";
const S_INGRID_2 = "00000000-0000-4000-8000-000000000203";
const S_ROSANA = "00000000-0000-4000-8000-000000000204";
const S_INSTAGRAM = "00000000-0000-4000-8000-000000000205";
const S_ARQUIVADA = "00000000-0000-4000-8000-000000000206";
const S_OUTRA_ORG = "00000000-0000-4000-8000-000000000207";

function sessao(id: string, org: string, nome: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: org,
    display_name: nome,
    phone_number: "5511999990000",
    provider: DEFAULT_CHANNEL_PROVIDER,
    status: "WORKING",
    metadata: {},
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    responsible_user_id: null,
    ...extra,
  };
}

function cenario(p: { modo?: "choose" | "own_only"; ingrid1Fora?: boolean; comRoteamentoDaRosana?: boolean } = {}) {
  return bancoEmMemoria({
    organizations: [{ id: ORG, settings: { routing: { conversation_connection_mode: p.modo ?? "choose" } } }],
    channel_sessions: [
      sessao(S_GERAL, ORG, "Número geral"),
      sessao(S_INGRID_1, ORG, "Ingrid 1", {
        responsible_user_id: INGRID,
        ...(p.ingrid1Fora ? { status: "STOPPED" } : {}),
      }),
      sessao(S_INGRID_2, ORG, "Ingrid 2", { responsible_user_id: INGRID }),
      sessao(S_ROSANA, ORG, "Rosana", { responsible_user_id: ROSANA }),
      sessao(S_INSTAGRAM, ORG, "Instagram", { provider: CHANNEL_PROVIDER_META_SOCIAL, responsible_user_id: INGRID }),
      sessao(S_ARQUIVADA, ORG, "Arquivada", { archived_at: "2026-06-01T00:00:00Z", responsible_user_id: INGRID }),
      // Linha forjada: outra empresa com a Ingrid como responsável.
      sessao(S_OUTRA_ORG, OUTRA_ORG, "De outra empresa", { responsible_user_id: INGRID }),
    ],
    channel_routing_policies: p.comRoteamentoDaRosana
      ? [{ id: "p-rosana", organization_id: ORG, channel_session_id: S_ROSANA }]
      : [],
    channel_routing_responsibles: p.comRoteamentoDaRosana
      ? [{ organization_id: ORG, policy_id: "p-rosana", user_id: ROSANA }]
      : [],
  });
}

const base = { organizationId: ORG, userId: INGRID, role: "agent" };

describe("carregarOpcoesDeAbertura — os dados do seletor", () => {
  it("lista só conexões 1:1 vivas desta organização, e marca as vinculadas a mim", async () => {
    const op = await carregarOpcoesDeAbertura(cenario(), base);
    const ids = (op.conexoes_do_seletor ?? []).map((x) => x.id);
    expect(ids).toEqual([S_GERAL, S_INGRID_1, S_INGRID_2, S_ROSANA]);
    expect(ids).not.toContain(S_INSTAGRAM);
    expect(ids).not.toContain(S_ARQUIVADA);
    expect(ids).not.toContain(S_OUTRA_ORG);
    expect(op.vinculadas_a_mim_ids).toEqual([S_INGRID_1, S_INGRID_2]);
    expect(conexaoPadraoDoSeletor(op)?.id).toBe(S_INGRID_1);
  });

  it("a primeira vinculada fora do ar: o padrão é a segunda, que está conectada", async () => {
    const op = await carregarOpcoesDeAbertura(cenario({ ingrid1Fora: true }), base);
    expect(conexaoPadraoDoSeletor(op)).toEqual({ id: S_INGRID_2, nome: "Ingrid 2", conectada: true });
  });

  it("o vínculo de membro não mexe na regra de permissão (responsáveis do roteamento)", async () => {
    const op = await carregarOpcoesDeAbertura(cenario(), base);
    expect(op.minha_conexao).toBeNull();
    expect(op.minhas_conexoes_ids).toEqual([]);
  });

  it("modo 'só a conexão própria', atendente: o seletor só traz o que o POST aceitaria", async () => {
    // A conexão da Rosana tem responsável no roteamento; a Ingrid não tem conexão própria lá,
    // então só pode iniciar pelos números sem responsável.
    const op = await carregarOpcoesDeAbertura(cenario({ modo: "own_only", comRoteamentoDaRosana: true }), base);
    const ids = (op.conexoes_do_seletor ?? []).map((x) => x.id);
    expect(ids).not.toContain(S_ROSANA);
    expect(ids).toContain(S_INGRID_1);
  });
});
