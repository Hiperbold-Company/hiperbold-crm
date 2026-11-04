import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

import {
  ORG_ID,
  OUTRA_ORG,
  PIPE,
  authOk,
  etapa,
  funilRow,
  makeDb,
  type DbOpts,
  type Registro,
} from "@/tests/helpers/stages-db-double";

const OUTRO = "55555555-5555-4555-8555-555555555555";

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/duplicate`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const ctx = (id = PIPE) => ({ params: Promise.resolve({ id }) });

const SETTINGS = {
  fields: [
    { key: "turma", label: "Turma", type: "text", obrigatorio_em: { etapas: ["e2", "e-velha"], ao_ganhar: true } },
  ],
  lost_reasons: ["Preço", { label: "Sumiu", categoria: "contato" }],
  won_reasons: ["Fechou"],
  reabertura: "novo_negocio",
  // Chave que nenhum código conhece: a troca percorre o JSON inteiro, não uma lista de chaves.
  chave_inventada: { atalho: "e3", lista: ["e1", "e4"], fixo: "texto" },
  entrada_do_inbox: { stage_id: "e-velha" },
};

function cenario(over: { origem?: Record<string, unknown>; writeError?: DbOpts["writeError"] } = {}) {
  return makeDb({
    pipelines: [
      funilRow({
        id: PIPE,
        name: "PMA 2027",
        slug: "pma-2027",
        position: 1000,
        is_default: true,
        settings: SETTINGS,
        ...(over.origem ?? {}),
      }),
      funilRow({ id: OUTRO, name: "Outro", slug: "outro", position: 2000 }),
      funilRow({ id: "f-alheio", name: "Alheio", slug: "alheio", position: 500, organization_id: OUTRA_ORG }),
    ].map((p) => ({ ...p, is_client_pipeline: p.id === PIPE, vocabulary: { lead: "Aluno" } })) as never,
    stages: [
      etapa({ id: "e3", name: "Matriculado", slug: "matriculado", position: 3000, is_won: true, agent_stage_hint: "won" }),
      etapa({ id: "e1", name: "Novo", slug: "novo", position: 1000 }),
      etapa({ id: "e-velha", name: "Antiga", slug: "antiga", position: 1500, is_archived: true }),
      etapa({ id: "e4", name: "Desistiu", slug: "desistiu", position: 4000, is_lost: true }),
      etapa({ id: "e2", name: "Proposta", slug: "proposta", position: 2000 }),
      etapa({ id: "x1", name: "De outro funil", slug: "x1", position: 1, pipeline_id: OUTRO }),
    ],
    writeError: over.writeError,
  });
}

const insercaoDeEtapas = (db: Registro) =>
  db.escritas.find((e) => e.tipo === "insert" && e.table === "crm_stages")?.patch as Record<string, unknown>[] | undefined;

function novoFunil(db: Registro) {
  return db.tabelas.crm_pipelines.find((p) => p.name === "PMA 2028");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/pipelines/[id]/duplicate", () => {
  it("exige manager", async () => {
    authOk();
    cenario();
    const { POST } = await import("./route");
    await POST(req({ name: "PMA 2028" }), ctx());
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("copia as etapas vivas, na ordem, com a configuração de cada uma", async () => {
    authOk();
    const db = cenario();
    const { POST } = await import("./route");
    const res = await POST(req({ name: "PMA 2028" }), ctx());
    expect(res.status).toBe(201);

    const etapas = insercaoDeEtapas(db)!;
    expect(etapas.map((e) => e.name)).toEqual(["Novo", "Proposta", "Matriculado", "Desistiu"]);
    const novo = novoFunil(db)!;
    expect(etapas.every((e) => e.pipeline_id === novo.id && e.organization_id === ORG_ID)).toBe(true);
    expect(etapas.find((e) => e.name === "Matriculado")).toMatchObject({ is_won: true, agent_stage_hint: "won", slug: "matriculado" });
    // Estado não vem da origem: a autoria é de quem duplicou, e ninguém nasce arquivado.
    expect(etapas[0]).toMatchObject({ last_change_actor_kind: "user" });
    expect(etapas.some((e) => "id" in e || "is_archived" in e)).toBe(false);

    const body = (await res.json()) as { data: { id: string; stages: Array<{ name: string }> } };
    expect(body.data.id).toBe(novo.id);
    expect(body.data.stages.map((s) => s.name)).toEqual(["Novo", "Proposta", "Matriculado", "Desistiu"]);
  });

  it("copia o settings inteiro e troca todo id de etapa da origem pelo da etapa nova — em qualquer chave", async () => {
    authOk();
    const db = cenario();
    const { POST } = await import("./route");
    await POST(req({ name: "PMA 2028" }), ctx());

    const novo = novoFunil(db)!;
    const idNovo = (slug: string) =>
      db.tabelas.crm_stages.find((s) => s.pipeline_id === novo.id && s.slug === slug)!.id as string;
    const s = novo.settings as typeof SETTINGS;

    // Etapa arquivada não é copiada: o id dela sai do array.
    expect(s.fields[0]!.obrigatorio_em).toEqual({ etapas: [idNovo("proposta")], ao_ganhar: true });
    expect(s.chave_inventada).toEqual({ atalho: idNovo("matriculado"), lista: [idNovo("novo"), idNovo("desistiu")], fixo: "texto" });
    // `stage_id` aceita ausência no schema: a chave que apontava para a arquivada some.
    expect(s.entrada_do_inbox).toEqual({});
    expect(s.lost_reasons).toEqual(SETTINGS.lost_reasons);
    expect(s.won_reasons).toEqual(["Fechou"]);
    expect(s.reabertura).toBe("novo_negocio");
    expect(novo.vocabulary).toEqual({ lead: "Aluno" });
    // A origem não foi tocada.
    expect(db.tabelas.crm_pipelines.find((p) => p.id === PIPE)!.settings).toEqual(SETTINGS);
  });

  it("não copia padrão, funil de clientes nem arquivamento; nasce logo depois da origem com slug novo", async () => {
    authOk();
    const db = cenario();
    const { POST } = await import("./route");
    await POST(req({ name: "PMA 2028" }), ctx());

    const insert = db.escritas.find((e) => e.tipo === "insert" && e.table === "crm_pipelines")!.patch as Record<string, unknown>;
    expect(insert).toMatchObject({
      organization_id: ORG_ID,
      name: "PMA 2028",
      slug: "pma-2028",
      is_default: false,
      is_client_pipeline: false,
      is_archived: false,
    });
    expect(insert.position).toBeGreaterThan(1000);
    expect(insert.position).toBeLessThan(2000);
  });

  it("emite audit pipeline.duplicated com origem, novo e o número de etapas", async () => {
    authOk();
    const db = cenario();
    const { POST } = await import("./route");
    await POST(req({ name: "PMA 2028" }), ctx());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.duplicated",
        organizationId: ORG_ID,
        metadata: { origem_id: PIPE, novo_id: novoFunil(db)!.id, etapas: 4 },
      }),
    );
  });

  it("funil de OUTRA organização → 404, sem escrita", async () => {
    authOk();
    const db = cenario();
    const { POST } = await import("./route");
    const res = await POST(req({ name: "PMA 2028" }), ctx("f-alheio"));
    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
  });

  it("origem arquivada → 409 com frase, sem escrita", async () => {
    authOk();
    const db = cenario({ origem: { is_archived: true, is_default: false } });
    const { POST } = await import("./route");
    const res = await POST(req({ name: "PMA 2028" }), ctx());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("arquivado");
    expect(db.escritas).toEqual([]);
  });

  it("nome vazio → 400, sem escrita", async () => {
    authOk();
    const db = cenario();
    const { POST } = await import("./route");
    const res = await POST(req({ name: "   " }), ctx());
    expect(res.status).toBe(400);
    expect(db.escritas).toEqual([]);
  });

  it("nome de funil que já existe → 422, sem escrita", async () => {
    authOk();
    const db = cenario();
    const { POST } = await import("./route");
    const res = await POST(req({ name: "outro" }), ctx());
    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  it("Idempotency-Key que não é UUID → 400, sem escrita", async () => {
    authOk();
    const db = cenario();
    const { POST } = await import("./route");
    const res = await POST(req({ name: "PMA 2028" }, { "Idempotency-Key": "nao-uuid" }), ctx());
    expect(res.status).toBe(400);
    expect(db.escritas).toEqual([]);
  });

  it("etapas falham → o funil criado é APAGADO, e não há audit", async () => {
    authOk();
    const db = cenario({ writeError: (_n, table) => (table === "crm_stages" ? { code: "XX000", message: "boom" } : null) });
    const { POST } = await import("./route");
    const res = await POST(req({ name: "PMA 2028" }), ctx());
    expect(res.status).toBe(500);
    const compensacao = db.escritas.find((e) => e.tipo === "delete");
    expect(compensacao?.table).toBe("crm_pipelines");
    expect(compensacao?.filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(novoFunil(db)).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it("settings remapeado falha ao gravar → o funil criado é apagado", async () => {
    authOk();
    const db = cenario({ writeError: (n) => (n === 3 ? { code: "XX000", message: "boom" } : null) });
    const { POST } = await import("./route");
    const res = await POST(req({ name: "PMA 2028" }), ctx());
    expect(res.status).toBe(500);
    expect(db.escritas.at(-1)).toMatchObject({ tipo: "delete", table: "crm_pipelines" });
    expect(novoFunil(db)).toBeUndefined();
  });

  it("teto de funis do plano (PT402) → 402 com a frase fixa, sem etapas", async () => {
    authOk();
    const db = cenario({
      writeError: (_n, table) =>
        table === "crm_pipelines" ? { code: "PT402", message: "Limite do plano atingido", details: "funis" } as never : null,
    });
    const { POST } = await import("./route");
    const res = await POST(req({ name: "PMA 2028" }), ctx());
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("plano_limite_atingido");
    expect(body.error.message).toBe("O plano desta organização chegou ao limite de funis. Fale com o suporte para ampliar.");
    expect(insercaoDeEtapas(db)).toBeUndefined();
  });

  it("teto de etapas por funil (PT402) → 402, e o funil é desfeito", async () => {
    authOk();
    const db = cenario({
      writeError: (_n, table) =>
        table === "crm_stages"
          ? ({ code: "PT402", message: "Limite do plano atingido", details: "etapas_por_funil" } as never)
          : null,
    });
    const { POST } = await import("./route");
    const res = await POST(req({ name: "PMA 2028" }), ctx());
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "O plano desta organização chegou ao limite de etapas por funil. Fale com o suporte para ampliar.",
    );
    expect(db.escritas.find((e) => e.tipo === "delete")?.table).toBe("crm_pipelines");
  });

  it("conflito de slug no banco (23505) → 409", async () => {
    authOk();
    cenario({
      writeError: (_n, table) => (table === "crm_pipelines" ? { code: "23505", message: "dup" } : null),
    });
    const { POST } = await import("./route");
    const res = await POST(req({ name: "PMA 2028" }), ctx());
    expect(res.status).toBe(409);
  });
});
