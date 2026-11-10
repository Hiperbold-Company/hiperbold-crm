/**
 * Criar automação a partir de um modelo pronto (lote 5): a rota, o `flowGraphSchema`, o catálogo de modelos
 * e `comIdempotencia` rodam de verdade, até o banco (dublê em memória). Dublês: a autorização (tem teste
 * próprio), a guarda do suporte, o audit e `criarFluxo` do núcleo dos fluxos (tem teste próprio).
 * O modelo NUNCA publica: o resultado é um rascunho (`draft_graph`, sem versão ativa).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  autorizar: vi.fn(),
  suporte: vi.fn(async () => null as Response | null),
  audit: vi.fn(),
  db: null as unknown,
  criar: vi.fn(),
}));

vi.mock("@/lib/api/auth-dual-admin", async () => {
  const real = await vi.importActual<typeof import("@/lib/api/auth-dual-admin")>("@/lib/api/auth-dual-admin");
  return { ...real, autorizarAdministracao: deps.autorizar };
});
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.suporte }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => deps.db }));
vi.mock("@/lib/followup/administracao", async () => {
  const real = await vi.importActual<typeof import("@/lib/followup/administracao")>("@/lib/followup/administracao");
  return { ...real, criarFluxo: deps.criar };
});

import { POST } from "./route";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA = "aaaaaaaa-0000-4000-8000-000000000002";
const FUNIL = "bbbbbbbb-0000-4000-8000-000000000001";
const ETAPA = "cccccccc-0000-4000-8000-000000000001";
const ETAPA_DA_OUTRA = "cccccccc-0000-4000-8000-000000000002";
const ETAPA_ARQUIVADA = "cccccccc-0000-4000-8000-000000000003";
const PTR = "dddddddd-0000-4000-8000-000000000001";

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]>;

function banco() {
  function builder(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let valores: Linha | null = null;
    const rodar = () => {
      const t = (tabelas[tabela] ??= []);
      if (op === "insert") {
        if (tabela === "idempotency_keys" && t.some((l) => l.organization_id === valores!.organization_id && l.key === valores!.key && l.endpoint === valores!.endpoint)) {
          return { data: null, error: { code: "23505" } };
        }
        const nova = { id: `id-${t.length + 1}`, ...valores };
        t.push(nova);
        return { data: [nova], error: null };
      }
      const achadas = t.filter((l) => filtros.every((f) => f(l)));
      if (op === "update") achadas.forEach((l) => Object.assign(l, valores));
      if (op === "delete") tabelas[tabela] = t.filter((l) => !achadas.includes(l));
      return { data: achadas, error: null };
    };
    const q = {
      select: () => q,
      insert: (v: Linha) => ((op = "insert"), (valores = v), q),
      update: (v: Linha) => ((op = "update"), (valores = v), q),
      delete: () => ((op = "delete"), q),
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      gt: (c: string, v: string) => (filtros.push((l) => String(l[c]) > v), q),
      maybeSingle: async () => {
        const r = rodar();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = rodar();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(rodar()).then(ok, erro),
    };
    return q;
  }
  return { from: builder, rpc: vi.fn() };
}

function sessao() {
  return { ok: true, via: "session", actor: { type: "user", id: "u1", role: "manager" }, organizationId: ORG, supabase: {}, idioma: "pt-BR", user: { id: "u1" } };
}

const req = (corpo: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/v1/automacoes/modelos", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    crm_stages: [
      { id: ETAPA, organization_id: ORG, pipeline_id: FUNIL, is_archived: false },
      { id: ETAPA_DA_OUTRA, organization_id: OUTRA, pipeline_id: "bbbbbbbb-0000-4000-8000-000000000002", is_archived: false },
      { id: ETAPA_ARQUIVADA, organization_id: ORG, pipeline_id: FUNIL, is_archived: true },
    ],
    crm_pipelines: [
      { id: FUNIL, organization_id: ORG, settings: { fields: [{ key: "data_da_visita", label: "Data da visita", type: "date" }] } },
      {
        id: "bbbbbbbb-0000-4000-8000-000000000002",
        organization_id: OUTRA,
        settings: { fields: [{ key: "data_secreta", label: "Segredo da outra conta", type: "date" }] },
      },
    ],
    followup_flow_pointers: [],
    idempotency_keys: [],
  };
  deps.db = banco();
  deps.suporte.mockResolvedValue(null);
  deps.autorizar.mockResolvedValue(sessao());
  deps.criar.mockImplementation(async (_d: unknown, e: { name: string; surface: string }) => {
    tabelas.followup_flow_pointers!.push({
      id: PTR,
      organization_id: ORG,
      name: e.name,
      surface: e.surface,
      status: "draft",
      active_version_id: null,
    });
    return { id: PTR };
  });
});

describe("modelos de automação: quem pode", () => {
  it("papel abaixo de gerente: a recusa da autorização volta e nada é criado", async () => {
    deps.autorizar.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(req({ model_id: "boas_vindas" }))).status).toBe(403);
    expect(deps.autorizar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "manager", escrita: true }));
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("suporte em modo leitura: 403 antes de qualquer efeito", async () => {
    deps.suporte.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(req({ model_id: "boas_vindas" }))).status).toBe(403);
    expect(deps.autorizar).not.toHaveBeenCalled();
    expect(deps.criar).not.toHaveBeenCalled();
  });
});

describe("modelos de automação: entrada inválida", () => {
  it("corpo que não é JSON: 400", async () => {
    expect((await POST(req("{nao e json"))).status).toBe(400);
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it.each([
    ["sem model_id", {}],
    ["model_id vazio", { model_id: "" }],
    ["stage_id que não é uuid", { model_id: "qualificar", stage_id: "abc" }],
    ["campo desconhecido (strict)", { model_id: "boas_vindas", organization_id: OUTRA }],
    ["nome grande demais", { model_id: "boas_vindas", name: "x".repeat(81) }],
  ])("Zod recusa: %s → 422 e nada é criado", async (_n, corpo) => {
    const r = await POST(req(corpo));
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("validation_failed");
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("modelo que não existe: 404", async () => {
    const r = await POST(req({ model_id: "inexistente" }));
    expect(r.status).toBe(404);
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("modelo que pede etapa, sem etapa: 422", async () => {
    const r = await POST(req({ model_id: "qualificar" }));
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("trigger_stage_missing");
  });

  it("etapa de OUTRA organização: recusada como inexistente, sem criar nada", async () => {
    const r = await POST(req({ model_id: "qualificar", stage_id: ETAPA_DA_OUTRA }));
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("trigger_stage_not_found");
    expect(deps.criar).not.toHaveBeenCalled();
    expect(tabelas.followup_flow_pointers).toEqual([]);
  });

  it("etapa arquivada: recusada", async () => {
    const r = await POST(req({ model_id: "qualificar", stage_id: ETAPA_ARQUIVADA }));
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("trigger_stage_not_found");
  });

  it("campo de data que só existe no funil de OUTRA organização: recusado", async () => {
    const r = await POST(req({ model_id: "lembrete_antes_da_data", campo_de_data: "data_secreta" }));
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("campo_de_data_ausente");
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("modelo que pede campo de data, sem campo: 422", async () => {
    const r = await POST(req({ model_id: "lembrete_antes_da_data" }));
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("campo_de_data_ausente");
  });
});

describe("modelos de automação: sucesso e idempotência", () => {
  it("cria RASCUNHO: grafo em draft_graph, sem versão ativa, sem publicar, com audit", async () => {
    const r = await POST(req({ model_id: "boas_vindas", name: "Minha boas-vindas" }));
    expect(r.status).toBe(201);
    expect((await r.json()).data).toEqual({ id: PTR, model_id: "boas_vindas" });
    expect(deps.criar).toHaveBeenCalledWith(expect.anything(), { name: "Minha boas-vindas", surface: "automacao" });
    const ptr = tabelas.followup_flow_pointers![0]!;
    expect(ptr).toMatchObject({ status: "draft", active_version_id: null });
    const grafo = ptr.draft_graph as { nodes: Array<{ type: string }> };
    expect(grafo.nodes.map((n) => n.type)).toEqual(["trigger", "message", "end"]);
    expect((deps.db as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "automacao.criada_de_modelo", organizationId: ORG, metadata: { model_id: "boas_vindas" } }),
    );
  });

  it("etapa da própria organização: o grafo leva funil e etapa resolvidos NO SERVIDOR", async () => {
    const r = await POST(req({ model_id: "qualificar", stage_id: ETAPA }));
    expect(r.status).toBe(201);
    expect(JSON.stringify(tabelas.followup_flow_pointers![0]!.draft_graph)).toContain(FUNIL);
    expect(JSON.stringify(tabelas.followup_flow_pointers![0]!.draft_graph)).toContain(ETAPA);
  });

  it("campo de data de um funil da própria organização: aceito", async () => {
    const r = await POST(req({ model_id: "lembrete_antes_da_data", campo_de_data: "data_da_visita" }));
    expect(r.status).toBe(201);
    expect(JSON.stringify(tabelas.followup_flow_pointers![0]!.draft_graph)).toContain("data_da_visita");
  });

  it("mesma Idempotency-Key e mesmo corpo: um rascunho só, a segunda volta o mesmo recibo", async () => {
    const h = { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" };
    const a = await POST(req({ model_id: "boas_vindas" }, h));
    const b = await POST(req({ model_id: "boas_vindas" }, h));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await b.json()).data.id).toBe(PTR);
    expect(deps.criar).toHaveBeenCalledTimes(1);
    expect(tabelas.followup_flow_pointers).toHaveLength(1);
  });

  it("mesma Idempotency-Key com OUTRO corpo: 409 de conflito, nada novo é criado", async () => {
    const h = { "Idempotency-Key": "22222222-2222-4222-8222-222222222222" };
    await POST(req({ model_id: "boas_vindas" }, h));
    const r = await POST(req({ model_id: "boas_vindas", name: "Outro nome" }, h));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("idempotency_conflict");
    expect(deps.criar).toHaveBeenCalledTimes(1);
  });
});
