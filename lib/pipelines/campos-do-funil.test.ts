/**
 * A fachada dos campos do funil (1015) não devolve a mensagem crua do Postgres no corpo do 500: o
 * detalhe vai para o log, com o requestId. Só a borda é falsa (o cliente do banco e o log).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const logados = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/logger", () => ({
  logger: { error: (_m: string, c: Record<string, unknown>) => void logados.push(c), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";

import { criarCampoDoFunil, listarCamposDoFunil } from "./campos-do-funil";

const CRU = 'permission denied for table crm_pipelines (coluna "segredo")';

function banco(falhaEm: "crm_pipelines" | "crm_stages"): SupabaseClient {
  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const resposta = () =>
      tabela === falhaEm
        ? { data: null, error: { code: "42501", message: CRU } }
        : { data: { id: "f", name: "V", vocabulary: {}, settings: { fields: [] } }, error: null };
    q.select = () => q;
    q.eq = () => q;
    q.in = () => q;
    q.maybeSingle = async () => resposta();
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve(resposta()).then(ok);
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const deps = (falhaEm: "crm_pipelines" | "crm_stages") => ({
  supabase: banco(falhaEm),
  organizationId: "org",
  actor: { type: "user" as const, id: "u1" },
  requestId: "req-42",
  papel: "admin" as const,
});

beforeEach(() => {
  logados.length = 0;
});

describe("campos do funil: 500 sem texto do Postgres", () => {
  it("falha ao ler o funil: corpo genérico, detalhe no log com o requestId", async () => {
    const erro = await listarCamposDoFunil(deps("crm_pipelines"), "f").catch((e: unknown) => e);
    expect(erro).toMatchObject({ status: 500, code: "internal_error", message: MENSAGEM_DE_FALHA_INTERNA });
    expect(JSON.stringify(erro)).not.toContain("segredo");
    expect(logados).toEqual([expect.objectContaining({ request_id: "req-42", causa: CRU })]);
  });

  it("falha ao conferir as etapas: corpo genérico, detalhe no log", async () => {
    const erro = await criarCampoDoFunil(deps("crm_stages"), "f", {
      key: "x",
      label: "X",
      type: "text",
      obrigatorio_em: { etapas: ["11111111-1111-4111-8111-111111111111"] },
    }).catch((e: unknown) => e);
    expect(erro).toMatchObject({ status: 500, message: MENSAGEM_DE_FALHA_INTERNA });
    expect(logados).toEqual([expect.objectContaining({ request_id: "req-42", causa: CRU })]);
  });
});
