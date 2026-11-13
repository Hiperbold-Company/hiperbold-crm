/**
 * Importar automação de arquivo: a rota, `lib/automacoes/portabilidade.ts`, o `flowGraphSchema` e
 * `comIdempotencia` rodam de verdade, até o banco (dublê em memória). Dublês: a autorização (tem teste
 * próprio), a guarda do suporte, o audit, `criarFluxo` (tem teste próprio) e o catálogo da conta
 * (`portabilidade-db`, só leitura com filtro de organização).
 *
 * O que se prova: a prévia não escreve; a escolha precisa ser uma linha DESTA conta e do tipo certo; o
 * arquivo adulterado não cria nada; o resultado é um RASCUNHO (desligado) com os ids daqui.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogoDaConta } from "@/lib/automacoes/portabilidade";

const deps = vi.hoisted(() => ({
  autorizar: vi.fn(),
  suporte: vi.fn(async () => null as Response | null),
  audit: vi.fn(),
  db: null as unknown,
  criar: vi.fn(),
  catalogo: vi.fn(),
}));

vi.mock("@/lib/api/auth-dual-admin", async () => {
  const real = await vi.importActual<typeof import("@/lib/api/auth-dual-admin")>("@/lib/api/auth-dual-admin");
  return { ...real, autorizarAdministracao: deps.autorizar };
});
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.suporte }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => deps.db }));
vi.mock("@/lib/automacoes/portabilidade-db", () => ({ catalogoDaConta: deps.catalogo }));
vi.mock("@/lib/followup/administracao", async () => {
  const real = await vi.importActual<typeof import("@/lib/followup/administracao")>("@/lib/followup/administracao");
  return { ...real, criarFluxo: deps.criar };
});

import { POST } from "./route";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const FUNIL = "bbbbbbbb-0000-4000-8000-000000000001";
const ETAPA = "cccccccc-0000-4000-8000-000000000001";
const PESSOA = "eeeeeeee-0000-4000-8000-000000000001";
const ETAPA_DE_OUTRA_CONTA = "cccccccc-0000-4000-8000-000000000099";
const PTR = "dddddddd-0000-4000-8000-000000000001";

const CATALOGO: CatalogoDaConta = [
  { id: FUNIL, tipo: "funil", nome: "Vendas", ativo: true },
  { id: ETAPA, tipo: "etapa", nome: "Qualificado · Vendas", ativo: true },
  { id: PESSOA, tipo: "pessoa", nome: "Ingrid", ativo: true },
];

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
        if (
          tabela === "idempotency_keys" &&
          t.some((l) => l.organization_id === valores!.organization_id && l.key === valores!.key && l.endpoint === valores!.endpoint)
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
      then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(rodar()).then(ok, erro),
    };
    return q;
  }
  return { from: builder, rpc: vi.fn() };
}

const sempre = { type: "always" } as const;
function arquivo() {
  return {
    formato: "hiperbold-automacao",
    versao: 1,
    automacao: {
      nome: "Qualificar",
      grafo: {
        nodes: [
          {
            id: "n1",
            type: "trigger",
            label: "Início",
            position: { x: 0, y: 0 },
            config: { triggers: [{ kind: "lead_created" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
          },
          { id: "n2", type: "message", label: "Oi", position: { x: 0, y: 100 }, config: { body: "Olá!" } },
          {
            id: "n3",
            type: "wait",
            label: "Esperar",
            position: { x: 0, y: 200 },
            config: { mode: "fixed", duration_ms: 3_600_000 },
          },
          {
            id: "n4",
            type: "crm_action",
            label: "Mover",
            position: { x: 0, y: 300 },
            config: {
              actions: [
                { type: "move_deal", pipeline_id: "ref:f", stage_id: "ref:e" },
                { type: "set_owner", mode: { m: "user", user_id: "ref:p" } },
              ],
              on_error: "continue",
            },
          },
          { id: "n5", type: "end", label: "Fim", position: { x: 0, y: 400 }, config: { outcome: "converted" } },
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2", priority: 0, condition: sempre },
          { id: "e2", source: "n2", target: "n3", priority: 0, condition: sempre },
          { id: "e3", source: "n3", target: "n4", priority: 0, condition: sempre },
          { id: "e4", source: "n4", target: "n5", priority: 0, condition: sempre },
        ],
      },
    },
    referencias: [
      { id: "f", tipo: "funil", nome: "Vendas" },
      { id: "e", tipo: "etapa", nome: "Qualificado · Vendas" },
      { id: "p", tipo: "pessoa", nome: "Ingrid" },
    ],
  };
}
const ESCOLHAS = { f: FUNIL, e: ETAPA, p: PESSOA };

const req = (corpo: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/v1/automacoes/importar", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    followup_flow_pointers: [{ id: "x", organization_id: ORG, name: "Qualificar", surface: "automacao" }],
    idempotency_keys: [],
  };
  deps.db = banco();
  deps.suporte.mockResolvedValue(null);
  deps.catalogo.mockResolvedValue(CATALOGO);
  deps.autorizar.mockResolvedValue({
    ok: true,
    via: "session",
    actor: { type: "user", id: "u1", role: "manager" },
    organizationId: ORG,
    supabase: {},
    idioma: "pt-BR",
    user: { id: "u1" },
  });
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

describe("importar automação: quem pode", () => {
  it("abaixo de gerente: a recusa volta e nada é lido nem criado", async () => {
    deps.autorizar.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(req({ arquivo: arquivo(), previa: true }))).status).toBe(403);
    expect(deps.autorizar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "manager", escrita: true }));
    expect(deps.catalogo).not.toHaveBeenCalled();
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("suporte em modo leitura: 403 antes de qualquer efeito", async () => {
    deps.suporte.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(req({ arquivo: arquivo(), escolhas: ESCOLHAS }))).status).toBe(403);
    expect(deps.criar).not.toHaveBeenCalled();
  });
});

describe("importar automação: prévia", () => {
  it("resume, sugere pelo nome e consulta só a organização da sessão — sem escrever", async () => {
    const r = await POST(req({ arquivo: arquivo(), previa: true }));
    expect(r.status).toBe(200);
    const { data } = await r.json();
    expect(data).toMatchObject({ nome: "Qualificar", caixas: 5, gatilhos: ["lead_created"] });
    expect(Object.fromEntries(data.referencias.map((x: { id: string; sugestao: string }) => [x.id, x.sugestao]))).toEqual(ESCOLHAS);
    expect(deps.catalogo).toHaveBeenCalledWith(expect.anything(), ORG);
    expect(deps.criar).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe("importar automação: criar", () => {
  it("cria RASCUNHO com os ids daqui, nome livre e audit sem texto", async () => {
    const r = await POST(req({ arquivo: arquivo(), escolhas: ESCOLHAS }));
    expect(r.status).toBe(201);
    expect((await r.json()).data).toEqual({ id: PTR, name: "Qualificar (importado)" });
    const criado = tabelas.followup_flow_pointers!.find((p) => p.id === PTR)!;
    expect(criado).toMatchObject({ status: "draft", active_version_id: null, surface: "automacao" });
    const json = JSON.stringify(criado.draft_graph);
    expect(json).toContain(FUNIL);
    expect(json).toContain(ETAPA);
    expect(json).toContain(PESSOA);
    expect(json).not.toContain("ref:");
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "automacao.importada", organizationId: ORG, resourceId: PTR }),
    );
    expect(JSON.stringify(deps.audit.mock.calls)).not.toContain("Olá!");
  });

  it.each([
    ["escolha de outra conta", { ...ESCOLHAS, e: ETAPA_DE_OUTRA_CONTA }],
    ["pessoa no lugar da etapa", { ...ESCOLHAS, e: PESSOA }],
    ["escolha faltando", { f: FUNIL, e: ETAPA }],
  ])("%s: 422 referencias_pendentes e nada é criado", async (_n, escolhas) => {
    const r = await POST(req({ arquivo: arquivo(), escolhas }));
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("referencias_pendentes");
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("arquivo adulterado (id cru no grafo): 422 com o caminho, nada lido nem criado", async () => {
    const a = arquivo();
    (a.automacao.grafo.nodes[3]!.config as { actions: Array<Record<string, unknown>> }).actions[0]!.stage_id =
      ETAPA_DE_OUTRA_CONTA;
    const r = await POST(req({ arquivo: a, escolhas: ESCOLHAS }));
    expect(r.status).toBe(422);
    const corpo = await r.json();
    expect(corpo.error.code).toBe("arquivo_invalido");
    expect(corpo.error.details.problemas[0]).toContain("nodes.3.config.actions.0.stage_id");
    expect(deps.catalogo).not.toHaveBeenCalled();
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("corpo com campo desconhecido (organization_id) é recusado", async () => {
    const r = await POST(req({ arquivo: arquivo(), escolhas: ESCOLHAS, organization_id: "x" }));
    expect(r.status).toBe(422);
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("aninhamento de 250 mil níveis: 422, sem 500", async () => {
    const corpo = `{"arquivo":${"[".repeat(250_000)}${"]".repeat(250_000)}}`;
    const r = await POST(req(corpo));
    expect(r.status).toBe(422);
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("arquivo acima de 512 KB: 413", async () => {
    const a = arquivo();
    a.automacao.nome = "Q";
    (a.automacao.grafo.nodes[1]!.config as { body: string }).body = "x".repeat(600 * 1024);
    expect((await POST(req({ arquivo: a, escolhas: ESCOLHAS }))).status).toBe(413);
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("Idempotency-Key: o duplo clique cria uma automação só", async () => {
    const h = { "Idempotency-Key": "11111111-2222-4333-8444-555555555555" };
    const a = await POST(req({ arquivo: arquivo(), escolhas: ESCOLHAS }, h));
    const b = await POST(req({ arquivo: arquivo(), escolhas: ESCOLHAS }, h));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(deps.criar).toHaveBeenCalledTimes(1);
  });
});
