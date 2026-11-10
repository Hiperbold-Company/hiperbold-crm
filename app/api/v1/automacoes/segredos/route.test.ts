/**
 * As rotas do cofre de chaves das automações.
 *
 * O que roda de verdade: as rotas, `lib/automacoes/segredos.ts` (até o banco,
 * que é o dublê em memória, com a cifra `fn_encrypt_oauth` simulada) e
 * `comIdempotencia`. Dublês: a autorização (`autorizarAdministracao`, que tem
 * teste próprio — aqui o que se prova é que a rota NÃO toca o banco quando ela
 * recusa), a guarda do suporte e o audit (para ler o que foi auditado).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  autorizar: vi.fn(),
  suporte: vi.fn(async () => null as Response | null),
  audit: vi.fn(),
  db: null as unknown,
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

import { DELETE, PATCH } from "./[id]/route";
import { GET, POST } from "./route";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA = "aaaaaaaa-0000-4000-8000-000000000002";
const VALOR = "tok_SUPERSECRETO_9876";

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]>;
let consultas = 0;

function banco() {
  function builder(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    let lista: [string, unknown[]] | null = null;
    let op: "select" | "insert" | "update" | "delete" = "select";
    let valores: Linha | null = null;
    // Como o PostgREST: só as colunas pedidas voltam.
    let colunas: string[] | null = null;
    const projetar = (l: Linha) =>
      colunas ? Object.fromEntries(colunas.map((c) => [c, l[c]])) : l;
    const casa = (l: Linha) =>
      filtros.every(([c, v]) => l[c] === v) && (!lista || lista[1].includes(l[lista[0]]));
    const rodar = () => {
      consultas += 1;
      const t = (tabelas[tabela] ??= []);
      if (op === "insert") {
        if (
          t.some((l) => l.organization_id === valores!.organization_id && l.nome === valores!.nome)
        ) {
          return { data: null, error: { code: "23505" } };
        }
        const nova = {
          id: `bbbbbbbb-0000-4000-8000-00000000000${t.length + 1}`,
          created_at: "x",
          updated_at: "x",
          last_used_at: null,
          ...valores,
        };
        t.push(nova);
        return { data: [projetar(nova)], error: null };
      }
      const achadas = t.filter(casa);
      if (op === "update") achadas.forEach((l) => Object.assign(l, valores));
      if (op === "delete") tabelas[tabela] = t.filter((l) => !casa(l));
      return { data: achadas.map(projetar), error: null };
    };
    const q = {
      select: (c?: string) => (
        (colunas = c && c !== "*" ? c.split(",").map((x) => x.trim()) : null),
        q
      ),
      insert: (v: Linha) => ((op = "insert"), (valores = v), q),
      update: (v: Linha) => ((op = "update"), (valores = v), q),
      delete: () => ((op = "delete"), q),
      eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
      gt: () => q,
      in: (c: string, v: unknown[]) => ((lista = [c, v]), q),
      order: () => q,
      single: async () => {
        const r = rodar();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      maybeSingle: async () => {
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
    rpc: async (nome: string, args: { plaintext?: string }) =>
      nome === "fn_encrypt_oauth"
        ? { data: `\\xcifra(${args.plaintext!.length})`, error: null }
        : { data: null, error: null },
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
  };
}

function req(metodo: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/v1/automacoes/segredos", {
    method: metodo,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {};
  consultas = 0;
  deps.db = banco();
  deps.suporte.mockResolvedValue(null);
  deps.autorizar.mockResolvedValue(sessao());
});

describe("cofre de chaves: quem pode", () => {
  it("papel abaixo de gerente: 403 e o banco nem é consultado", async () => {
    deps.autorizar.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(req("POST", { nome: "token_meta", valor: VALOR }))).status).toBe(403);
    expect((await GET(req("GET"))).status).toBe(403);
    expect(consultas).toBe(0);
    expect(deps.autorizar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: "manager" }),
    );
  });

  it("suporte em modo leitura: 403 antes de qualquer efeito", async () => {
    deps.suporte.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(req("POST", { nome: "token_meta", valor: VALOR }))).status).toBe(403);
    expect((await DELETE(req("DELETE"), ctx("bbbbbbbb-0000-4000-8000-000000000001"))).status).toBe(
      403,
    );
    expect(consultas).toBe(0);
    expect(deps.autorizar).not.toHaveBeenCalled();
  });

  it("token dsk_ é recusado: chave secreta só pela tela", async () => {
    deps.autorizar.mockResolvedValue({
      ...sessao(),
      via: "token",
      actor: { type: "api_token", id: "t1" },
    });
    expect((await POST(req("POST", { nome: "token_meta", valor: VALOR }))).status).toBe(403);
    expect(consultas).toBe(0);
  });
});

describe("cofre de chaves: o valor nunca volta", () => {
  it("POST cria; resposta, lista e audit levam nome e ••••final, nunca o valor", async () => {
    const r = await POST(req("POST", { nome: "token_meta", valor: VALOR }));
    expect(r.status).toBe(201);
    const corpo = await r.text();
    expect(corpo).not.toContain(VALOR);
    expect(JSON.parse(corpo).data).toMatchObject({ nome: "token_meta", ultimos4: "9876" });
    expect(tabelas.automacao_segredos![0]).toMatchObject({
      organization_id: ORG,
      valor_cifrado: `\\xcifra(${VALOR.length})`,
    });
    expect(JSON.stringify(deps.audit.mock.calls)).not.toContain(VALOR);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "automacao.chave_criada", organizationId: ORG }),
    );

    const lista = await (await GET(req("GET"))).text();
    expect(lista).not.toContain(VALOR);
    expect(lista).not.toContain("cifra");
  });

  it("a organização vem da sessão, não do corpo", async () => {
    const r = await POST(req("POST", { nome: "x_chave", valor: VALOR, organization_id: OUTRA }));
    expect(r.status).toBe(400);
    await POST(req("POST", { nome: "x_chave", valor: VALOR }));
    expect(tabelas.automacao_segredos![0]!.organization_id).toBe(ORG);
  });

  it("chave curta (menos de 16) não mostra os finais; o audit nunca leva os finais", async () => {
    const curta = "abcd1234efgh";
    const r = await POST(req("POST", { nome: "token_curto", valor: curta }));
    expect(r.status).toBe(201);
    expect(JSON.parse(await r.text()).data.ultimos4).toBe("");
    expect(tabelas.automacao_segredos![0]!.ultimos4).toBe("");
    await POST(req("POST", { nome: "token_longo", valor: VALOR }));
    const metadados = deps.audit.mock.calls.map(
      (c: unknown[]) => (c[0] as { metadata?: Record<string, unknown> }).metadata,
    );
    expect(metadados.length).toBeGreaterThan(0);
    for (const m of metadados) expect(m).not.toHaveProperty("ultimos4");
    expect(JSON.stringify(deps.audit.mock.calls)).not.toContain(VALOR.slice(-4));
  });

  it("valor curto ou com espaço é recusado sem ecoar o valor", async () => {
    const r = await POST(req("POST", { nome: "token_meta", valor: "abc def ghi" }));
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain("abc def ghi");
  });

  it("nome repetido: 409", async () => {
    await POST(req("POST", { nome: "token_meta", valor: VALOR }));
    expect((await POST(req("POST", { nome: "token_meta", valor: `${VALOR}x` }))).status).toBe(409);
  });

  it("Idempotency-Key: a retentativa não cria duas chaves", async () => {
    const chave = "cccccccc-0000-4000-8000-000000000001";
    const a = await POST(
      req("POST", { nome: "token_meta", valor: VALOR }, { "Idempotency-Key": chave }),
    );
    const b = await POST(
      req("POST", { nome: "token_meta", valor: VALOR }, { "Idempotency-Key": chave }),
    );
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(tabelas.automacao_segredos).toHaveLength(1);
    expect(JSON.stringify(tabelas.idempotency_keys ?? [])).not.toContain(VALOR);
  });

  it("PATCH troca o valor (e o final); chave de outra organização é 404", async () => {
    await POST(req("POST", { nome: "token_meta", valor: VALOR }));
    const id = tabelas.automacao_segredos![0]!.id as string;
    const r = await PATCH(req("PATCH", { valor: "novo_valor_X_ABCD" }), ctx(id));
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain("novo_valor_X_ABCD");
    expect(tabelas.automacao_segredos![0]!.ultimos4).toBe("ABCD");
    tabelas.automacao_segredos![0]!.organization_id = OUTRA;
    expect((await PATCH(req("PATCH", { valor: "novo_valor_X_ABCD" }), ctx(id))).status).toBe(404);
  });
});

describe("cofre de chaves: apagar", () => {
  it("chave usada por automação publicada: 409 com o nome da automação, e nada apagado", async () => {
    await POST(req("POST", { nome: "token_meta", valor: VALOR }));
    const id = tabelas.automacao_segredos![0]!.id as string;
    tabelas.followup_flow_pointers = [
      {
        id: "p1",
        name: "Rastrear anúncio",
        organization_id: ORG,
        surface: "automacao",
        status: "active",
        active_version_id: "v1",
      },
    ];
    tabelas.followup_flow_versions = [
      {
        id: "v1",
        organization_id: ORG,
        graph: {
          nodes: [
            {
              type: "http_request",
              config: {
                headers: [{ kind: "chave", name: "Authorization", secret_id: id, prefix: "" }],
              },
            },
          ],
        },
      },
    ];
    const r = await DELETE(req("DELETE"), ctx(id));
    expect(r.status).toBe(409);
    const corpo = await r.json();
    expect(corpo.error.code).toBe("segredo_em_uso");
    expect(corpo.error.message).toContain("Rastrear anúncio");
    expect(tabelas.automacao_segredos).toHaveLength(1);
  });

  it("chave sem uso: apaga e audita", async () => {
    await POST(req("POST", { nome: "token_meta", valor: VALOR }));
    const id = tabelas.automacao_segredos![0]!.id as string;
    const r = await DELETE(req("DELETE"), ctx(id));
    expect(r.status).toBe(200);
    expect(tabelas.automacao_segredos).toHaveLength(0);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "automacao.chave_apagada" }),
    );
  });
});
