/**
 * Converter regra antiga em automação (lote 5): a rota e `lib/automacoes/conversao.ts` rodam de
 * verdade, até o banco (dublê em memória) e `comIdempotencia`. Dublês: a autorização (tem teste
 * próprio), a guarda do suporte, o audit, e `criarFluxo`/`publicarFluxo` do núcleo dos fluxos (têm
 * teste próprio) — o dublê do publish chama o publicador que a conversão passa, então a RPC
 * `fn_automacao_converter_regra` é a que esta rota escolheu. A atomicidade no banco é provada no
 * invariante `tests/invariants/automacao-converter-regra.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  autorizar: vi.fn(),
  suporte: vi.fn(async () => null as Response | null),
  audit: vi.fn(),
  db: null as unknown,
  criar: vi.fn(),
  publicar: vi.fn(),
}));

vi.mock("@/lib/api/auth-dual-admin", async () => {
  const real = await vi.importActual<typeof import("@/lib/api/auth-dual-admin")>(
    "@/lib/api/auth-dual-admin",
  );
  return { ...real, autorizarAdministracao: deps.autorizar };
});
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.suporte }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => deps.db }));
vi.mock("@/lib/followup/administracao", async () => {
  const real = await vi.importActual<typeof import("@/lib/followup/administracao")>(
    "@/lib/followup/administracao",
  );
  return { ...real, criarFluxo: deps.criar, publicarFluxo: deps.publicar };
});

import { GET, POST } from "./route";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA = "aaaaaaaa-0000-4000-8000-000000000002";
const R1 = "cccccccc-0000-4000-8000-000000000001";
const R2 = "cccccccc-0000-4000-8000-000000000002";
const R3 = "cccccccc-0000-4000-8000-000000000003";
const PTR = "dddddddd-0000-4000-8000-000000000001";

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]>;
let rpcs: Array<{ nome: string; args: Record<string, unknown> }>;

function banco() {
  function builder(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let valores: Linha | null = null;
    const rodar = () => {
      const t = (tabelas[tabela] ??= []);
      if (op === "insert") {
        if (
          tabela === "idempotency_keys" &&
          t.some(
            (l) =>
              l.organization_id === valores!.organization_id &&
              l.key === valores!.key &&
              l.endpoint === valores!.endpoint,
          )
        ) {
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
      then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
        Promise.resolve(rodar()).then(ok, erro),
    };
    return q;
  }
  return {
    from: builder,
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      // O que a 1005 faz, em uma "transação": desliga a regra, grava o vínculo, publica.
      const regra = tabelas.automation_rules!.find(
        (r) => r.id === args.p_rule && r.organization_id === args.p_org,
      );
      if (!regra) return { data: null, error: { message: "rule_not_found" } };
      if (regra.migrated_to_pointer_id)
        return { data: null, error: { message: "rule_already_converted" } };
      Object.assign(regra, { is_active: false, migrated_to_pointer_id: args.p_pointer });
      const p = tabelas.followup_flow_pointers!.find((x) => x.id === args.p_pointer)!;
      Object.assign(p, { status: "active", active_version_id: "v1" });
      return { data: "v1", error: null };
    },
  };
}

function sessao(role = "manager") {
  return {
    ok: true,
    via: "session",
    actor: { type: "user", id: "u1", role },
    organizationId: ORG,
    supabase: {},
    idioma: "pt-BR",
    user: { id: "u1" },
  };
}
const req = (metodo: string, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/v1/automacoes/converter-regra/x", {
    method: metodo,
    headers,
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const regraConversivel = (id: string, org = ORG): Linha => ({
  id,
  organization_id: org,
  name: "Boas-vindas",
  trigger_event: "lead.created",
  trigger_config: {},
  conditions: [],
  actions: [{ type: "add_tag", config: { tags: ["novo"] } }],
  is_active: true,
  migrated_to_pointer_id: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  rpcs = [];
  tabelas = {
    automation_rules: [
      regraConversivel(R1),
      { ...regraConversivel(R2), actions: [{ type: "send_email", config: {} }] },
      regraConversivel(R3, OUTRA),
    ],
    followup_flow_pointers: [],
    idempotency_keys: [],
  };
  deps.db = banco();
  deps.suporte.mockResolvedValue(null);
  deps.autorizar.mockResolvedValue(sessao());
  deps.criar.mockImplementation(async (_d: unknown, e: { name: string }) => {
    tabelas.followup_flow_pointers!.push({
      id: PTR,
      organization_id: ORG,
      name: e.name,
      surface: "automacao",
      status: "draft",
      active_version_id: null,
    });
    return { id: PTR };
  });
  deps.publicar.mockImplementation(
    async (
      d: { admin: unknown; organizationId: string; responsavel: string },
      id: string,
      publicador: (a: unknown, p: unknown) => Promise<unknown>,
    ) => {
      const p = tabelas.followup_flow_pointers!.find((x) => x.id === id)!;
      return publicador(d.admin, {
        orgId: d.organizationId,
        pointerId: id,
        graph: p.draft_graph,
        createdBy: d.responsavel,
      });
    },
  );
});

describe("converter regra: quem pode", () => {
  it("papel abaixo de gerente: a recusa da autorização volta e nada é gravado", async () => {
    deps.autorizar.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(req("POST"), ctx(R1))).status).toBe(403);
    expect((await GET(req("GET"), ctx(R1))).status).toBe(403);
    expect(deps.autorizar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: "manager" }),
    );
    expect(tabelas.automation_rules![0]!.is_active).toBe(true);
  });

  it("suporte em modo leitura: 403 antes de qualquer efeito", async () => {
    deps.suporte.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(req("POST"), ctx(R1))).status).toBe(403);
    expect(deps.autorizar).not.toHaveBeenCalled();
    expect(rpcs).toEqual([]);
  });

  it("regra de outra organização: 404, sem RPC e sem rascunho", async () => {
    expect((await GET(req("GET"), ctx(R3))).status).toBe(404);
    expect((await POST(req("POST"), ctx(R3))).status).toBe(404);
    expect(rpcs).toEqual([]);
    expect(tabelas.followup_flow_pointers).toEqual([]);
    expect(tabelas.automation_rules![2]!.is_active).toBe(true);
  });
});

describe("converter regra: pré-visualização e publicação", () => {
  it("GET mostra o grafo sem gravar nada", async () => {
    const r = await GET(req("GET"), ctx(R1));
    expect(r.status).toBe(200);
    const { data } = await r.json();
    expect(data.conversivel).toBe(true);
    expect(data.grafo.nodes.map((n: { type: string }) => n.type)).toEqual([
      "trigger",
      "crm_action",
      "end",
    ]);
    expect(tabelas.followup_flow_pointers).toEqual([]);
  });

  it("POST publica pela função atômica: regra desligada, vínculo gravado, automação ligada, audit", async () => {
    const r = await POST(req("POST"), ctx(R1));
    expect(r.status).toBe(201);
    expect(rpcs.map((x) => x.nome)).toEqual(["fn_automacao_converter_regra"]);
    expect(rpcs[0]!.args).toMatchObject({ p_org: ORG, p_rule: R1, p_pointer: PTR });
    expect(tabelas.automation_rules![0]).toMatchObject({
      is_active: false,
      migrated_to_pointer_id: PTR,
    });
    expect(tabelas.followup_flow_pointers![0]).toMatchObject({ status: "active" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "automacao.regra_convertida", organizationId: ORG }),
    );
  });

  it("regra não conversível: 422 com o motivo, a regra segue ligada e nenhum rascunho nasce", async () => {
    const r = await POST(req("POST"), ctx(R2));
    expect(r.status).toBe(422);
    const corpo = await r.json();
    expect(corpo.error.code).toBe("regra_nao_conversivel");
    expect(corpo.error.details.nao_convertido[0]).toMatchObject({
      parte: "acao",
      item: "send_email",
    });
    expect(deps.criar).not.toHaveBeenCalled();
    expect(tabelas.automation_rules![1]!.is_active).toBe(true);
  });

  it("publish recusado depois do rascunho: o rascunho é apagado e a regra continua ligada", async () => {
    const { ApiError } = await import("@/lib/api/types");
    deps.publicar.mockRejectedValue(
      new ApiError(422, "validation_failed", undefined, "r", "reprovado"),
    );
    expect((await POST(req("POST"), ctx(R1))).status).toBe(422);
    expect(tabelas.followup_flow_pointers).toEqual([]);
    expect(tabelas.automation_rules![0]).toMatchObject({
      is_active: true,
      migrated_to_pointer_id: null,
    });
  });

  it("mesma Idempotency-Key: uma conversão só, a segunda volta o mesmo recibo", async () => {
    const h = { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" };
    const a = await POST(req("POST", h), ctx(R1));
    const b = await POST(req("POST", h), ctx(R1));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await b.json()).data.pointer_id).toBe(PTR);
    expect(deps.criar).toHaveBeenCalledTimes(1);
    expect(rpcs).toHaveLength(1);
  });

  it("sem chave, o reenvio também não duplica: devolve o vínculo existente", async () => {
    await POST(req("POST"), ctx(R1));
    const b = await POST(req("POST"), ctx(R1));
    expect(b.status).toBe(200);
    expect((await b.json()).data).toMatchObject({ pointer_id: PTR, ja_convertida: true });
    expect(deps.criar).toHaveBeenCalledTimes(1);
  });
});
