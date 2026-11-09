import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";
import { FRASE_COMENTARIO_SO_NO_MAX } from "@/lib/automacoes/comentario-no-plano";

import { publicarFluxo, type DepsDeFollowup } from "./administracao";

/**
 * D-227: publicar automação com gatilho "Comentário no Instagram" é recusado (402 plano_limite_atingido)
 * quando o plano não inclui o recurso, e quando a leitura do plano falha. O cliente falso é o do limite da
 * rede (tabelas e RPC), nunca o módulo de plano.
 */
const ORG = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";

const GRAFO = {
  nodes: [{ id: "t", type: "trigger", label: "Início", config: { triggers: [{ kind: "instagram_comment", match: "any", keywords: [] }] } }],
  edges: [],
};

function admin(comentario: number | "erro"): SupabaseClient {
  const linha = (data: unknown) => {
    const c = { select: () => c, eq: () => c, maybeSingle: async () => ({ data, error: null }) };
    return c;
  };
  return {
    from: (tabela: string) =>
      tabela === "followup_flow_pointers"
        ? linha({ id: ID, draft_graph: GRAFO, trigger_config: { kind: "manual" }, surface: "automacao" })
        : linha({ status: "ativa", cycle: "monthly", billing_plans: { code: "pro", name: "Pro", version: 2 } }),
    rpc: async () =>
      comentario === "erro"
        ? { data: null, error: { message: "fora" } }
        : {
            data: {
              funis: 5, etapas_por_funil: 10, leads: 5000, membros: 3, conexoes: 3, integracoes_webhook: 3,
              tokens_ia_mes: 1, agentes_ia: 1, automacoes: 10, mcp_req_min: 0, acesso_api: 0,
              automacao_comentario_instagram: comentario, fonte_dados_req_min: 60,
            },
            error: null,
          },
  } as unknown as SupabaseClient;
}

const deps = (a: SupabaseClient): DepsDeFollowup => ({
  supabase: a,
  admin: a,
  organizationId: ORG,
  actor: { kind: "user", userId: "u" } as never,
  responsavel: "00000000-0000-4000-8000-0000000000cc",
  requestId: "req",
});

async function recusa(a: SupabaseClient): Promise<ApiError | null> {
  try {
    await publicarFluxo(deps(a), ID);
    return null;
  } catch (e) {
    return e instanceof ApiError ? e : null;
  }
}

describe("publicar automação por comentário do Instagram", () => {
  it("plano sem o recurso (Pro): 402 plano_limite_atingido com a frase do Max", async () => {
    const e = await recusa(admin(0));
    expect(e?.status).toBe(402);
    expect(e?.code).toBe("plano_limite_atingido");
    expect(e?.message).toBe(FRASE_COMENTARIO_SO_NO_MAX);
  });

  it("leitura do plano que falha também recusa", async () => {
    expect((await recusa(admin("erro")))?.code).toBe("plano_limite_atingido");
  });

  it("plano com o recurso (Max): passa da trava do plano (pode falhar adiante, mas não por ela)", async () => {
    const e = await recusa(admin(1));
    expect(e?.code).not.toBe("plano_limite_atingido");
  });
});
