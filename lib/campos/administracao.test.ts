/**
 * O núcleo dos campos da organização (1015) contra um banco EM MEMÓRIA que só entende o que o
 * PostgREST entende (filtros `eq`, `insert`, `update`, `delete`). Ele aplica de verdade o filtro de
 * organização — é o que o isolamento entre organizações depende de o núcleo mandar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditados = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async (e: Record<string, unknown>) => void auditados.push(e)) }));
const rpc = vi.hoisted(() => vi.fn(async () => ({ data: { total: 4, preenchidos: 3 }, error: null })));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { alterarDefinicao, criarDefinicao, listarDefinicoes, removerDefinicao } from "./administracao";
import { COTA_DE_CAMPOS_POR_ENTIDADE } from "./definicoes";

type Linha = Record<string, unknown>;

function bancoEmMemoria(linhas: Linha[]): SupabaseClient {
  let seq = 0;
  const from = () => {
    const filtros: Array<[string, unknown]> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let carga: Linha | null = null;
    const casa = (l: Linha) => filtros.every(([c, v]) => l[c] === v);
    const executar = () => {
      if (op === "insert") {
        const nova: Linha = { id: `id-${++seq}`, created_at: "t", updated_at: "t", ...carga! };
        if (linhas.some((l) => l.organization_id === nova.organization_id && String(l.key).toLowerCase() === String(nova.key).toLowerCase())) {
          return { data: null, error: { code: "23505", message: "dup" } };
        }
        linhas.push(nova);
        return { data: [nova], error: null };
      }
      const alvo = linhas.filter(casa);
      if (op === "update") alvo.forEach((l) => Object.assign(l, carga));
      if (op === "delete") alvo.forEach((l) => linhas.splice(linhas.indexOf(l), 1));
      return { data: alvo, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      insert: (c: Linha) => ((op = "insert"), (carga = c), q),
      update: (c: Linha) => ((op = "update"), (carga = c), q),
      delete: () => ((op = "delete"), q),
      eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
      order: () => q,
      maybeSingle: async () => {
        const r = executar();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = executar();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (ok: (v: unknown) => unknown) => Promise.resolve(executar()).then(ok),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const ORG_A = "org-a";
const ORG_B = "org-b";
let linhas: Linha[];
const deps = (org: string) => ({
  supabase: bancoEmMemoria(linhas),
  organizationId: org,
  actor: { type: "user" as const, id: "u1" },
  requestId: "req",
});

beforeEach(() => {
  auditados.length = 0;
  linhas = [
    { id: "b1", organization_id: ORG_B, entidade: "negocio", key: "segredo_b", label: "B", type: "text", config: {}, position: 1000 },
  ];
});

describe("campos da organização: isolamento, imutáveis, cota e audit", () => {
  it("lista só a organização da porta — a de B não aparece para A", async () => {
    await criarDefinicao(deps(ORG_A), { entidade: "negocio", key: "origem", label: "Origem", type: "text" });
    expect((await listarDefinicoes(deps(ORG_A))).map((d) => d.key)).toEqual(["origem"]);
  });

  it("alterar ou excluir a definição de OUTRA organização responde 404 e não mexe nela", async () => {
    await expect(alterarDefinicao(deps(ORG_A), "b1", { label: "Hack" })).rejects.toMatchObject({ status: 404 });
    await expect(removerDefinicao(deps(ORG_A), "b1")).rejects.toMatchObject({ status: 404 });
    expect(linhas.find((l) => l.id === "b1")?.label).toBe("B");
  });

  it("chave repetida sem diferenciar maiúsculas é 409, inclusive entre contato e negócio", async () => {
    await criarDefinicao(deps(ORG_A), { entidade: "negocio", key: "cidade", label: "Cidade", type: "text" });
    await expect(
      criarDefinicao(deps(ORG_A), { entidade: "contato", key: "Cidade", label: "Cidade", type: "text" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("a cota é por entidade: o 51º campo de negócio é 422, o de contato ainda entra", async () => {
    for (let i = 0; i < COTA_DE_CAMPOS_POR_ENTIDADE; i += 1) {
      linhas.push({ id: `n${i}`, organization_id: ORG_A, entidade: "negocio", key: `n${i}`, label: "N", type: "text", config: {}, position: i });
    }
    await expect(
      criarDefinicao(deps(ORG_A), { entidade: "negocio", key: "mais_um", label: "X", type: "text" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      criarDefinicao(deps(ORG_A), { entidade: "contato", key: "do_contato", label: "X", type: "text" }),
    ).resolves.toMatchObject({ key: "do_contato" });
  });

  it("lista fechada sem opção é 422 antes de tocar no banco", async () => {
    await expect(
      criarDefinicao(deps(ORG_A), { entidade: "negocio", key: "tipo", label: "Tipo", type: "select" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(linhas.some((l) => l.key === "tipo")).toBe(false);
  });

  it("alterar faz merge do config por chave e `null` tira a chave", async () => {
    const d = await criarDefinicao(deps(ORG_A), {
      entidade: "negocio",
      key: "cep",
      label: "CEP",
      type: "text",
      config: { padrao: "^\\d{8}$", mensagem_padrao: "Só números" },
    });
    await alterarDefinicao(deps(ORG_A), d.id, { config: { mensagem_padrao: undefined, padrao: "^\\d{5}-?\\d{3}$" } });
    expect(linhas.find((l) => l.id === d.id)?.config).toEqual({ padrao: "^\\d{5}-?\\d{3}$", mensagem_padrao: "Só números" });
    await alterarDefinicao(deps(ORG_A), d.id, { config: { mensagem_padrao: null as unknown as string } });
    expect(linhas.find((l) => l.id === d.id)?.config).toEqual({ padrao: "^\\d{5}-?\\d{3}$" });
  });

  it("criar, alterar e excluir auditam com a organização da porta; a exclusão leva a contagem, nunca valor", async () => {
    const d = await criarDefinicao(deps(ORG_A), { entidade: "negocio", key: "origem", label: "Origem", type: "text" });
    await alterarDefinicao(deps(ORG_A), d.id, { label: "Origem do lead" });
    const r = await removerDefinicao(deps(ORG_A), d.id);
    expect(r.registros_com_valor).toBe(3);
    expect(auditados.map((a) => a.action)).toEqual(["custom_field.created", "custom_field.updated", "custom_field.deleted"]);
    expect(auditados.every((a) => a.organizationId === ORG_A && a.actorUserId === "u1")).toBe(true);
    expect(auditados[2]?.metadata).toEqual({ entidade: "negocio", key: "origem", registros_com_valor: 3 });
    expect(rpc).toHaveBeenCalledWith("fn_estatisticas_do_campo_personalizado", {
      p_org: ORG_A,
      p_entidade: "negocio",
      p_key: "origem",
    });
  });
});
