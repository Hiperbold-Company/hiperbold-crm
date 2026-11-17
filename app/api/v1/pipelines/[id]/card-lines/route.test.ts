import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/v1/pipelines/[id]/card-lines — "Editar cartão".
 *
 * Roda com o `requireRole` DE VERDADE: o dublado é a borda dele (quem está
 * logado, a organização ativa e o papel que o banco devolve pelo rpc) e o banco
 * da gravação, uma tabela em memória que APLICA os filtros `eq`. Assim "outra
 * organização não altera" e "o merge preserva" são medidos no estado da tabela.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
  mfaEmDividaEstrita: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "44444444-4444-4444-8444-444444444444";
const FUNIL = "22222222-2222-4222-8222-222222222222";
const FUNIL_DA_OUTRA = "55555555-5555-4555-8555-555555555555";
const USUARIO = "33333333-3333-4333-8333-333333333333";

type Linha = Record<string, unknown>;
let tabela: Linha[];
let papel: string | null;

function banco() {
  return {
    rpc: vi.fn(async () => ({ data: papel, error: null })),
    from: () => {
      const filtros: Array<[string, unknown]> = [];
      let mudanca: Linha | null = null;
      const achadas = () => tabela.filter((l) => filtros.every(([c, v]) => (l[c] ?? null) === v));
      const b = {
        select: () => b,
        update: (v: Linha) => {
          mudanca = v;
          return b;
        },
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          // `.update(...).eq(...).select("id")` termina aqui: o builder é "thenable".
          return b;
        },
        maybeSingle: async () => {
          const a = achadas();
          return { data: a[0] ? structuredClone(a[0]) : null, error: null };
        },
        then: (resolve: (r: { data: Linha[]; error: null }) => void) => {
          const a = achadas();
          if (mudanca) for (const l of a) Object.assign(l, mudanca, { updated_at: `${Date.now()}-${Math.random()}` });
          resolve({ data: a.map((l) => ({ id: l.id })), error: null });
        },
      };
      return b;
    },
  };
}

const chamar = (body: unknown, id = FUNIL) =>
  PATCH(
    new NextRequest(`http://localhost/api/v1/pipelines/${id}/card-lines`, {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  tabela = [
    {
      id: FUNIL,
      organization_id: ORG,
      updated_at: "v1",
      settings: { fields: [{ key: "x" }], atalhos: [{ rotulo: "a" }], ocultar_encerrados_dias: 30 },
    },
    { id: FUNIL_DA_OUTRA, organization_id: OUTRA_ORG, updated_at: "v1", settings: { fields: [] } },
  ];
  papel = "manager";
  vi.mocked(createClient).mockImplementation(async () => banco() as never);
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: USUARIO,
    is_platform_admin: false,
    support: null,
    organizations: [],
    idioma: "pt-BR",
  } as never);
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({
    orgId: ORG,
    name: "Empresa",
    role: "manager",
    org_status: "active",
  } as never);
});

describe("PATCH …/pipelines/[id]/card-lines", () => {
  it("sem login: 401", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null);
    expect((await chamar({ card_lines: ["email"] })).status).toBe(401);
  });

  it("⭐ atendente (agent) recebe 403 e o funil não muda", async () => {
    papel = "agent";
    const r = await chamar({ card_lines: ["email"] });
    expect(r.status).toBe(403);
    expect(tabela[0]!.settings).not.toHaveProperty("card_lines");
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "pipeline.card_lines_updated" }));
  });

  it.each(["manager", "admin"])("⭐ %s grava, o merge preserva as outras chaves, e audita", async (p) => {
    papel = p;
    const r = await chamar({ card_lines: ["utm_campaign", "email"] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({
      card_lines: ["utm_campaign", "email"],
      padrao: false,
    });
    expect(tabela[0]!.settings).toEqual({
      fields: [{ key: "x" }],
      atalhos: [{ rotulo: "a" }],
      ocultar_encerrados_dias: 30,
      card_lines: ["utm_campaign", "email"],
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.card_lines_updated",
        organizationId: ORG,
        actorUserId: USUARIO,
        resourceId: FUNIL,
        metadata: { card_lines: ["utm_campaign", "email"], voltou_ao_padrao: false },
      }),
    );
  });

  it("lista vazia é gravada como vazia (zero linhas vale)", async () => {
    expect((await chamar({ card_lines: [] })).status).toBe(200);
    expect(tabela[0]!.settings).toMatchObject({ card_lines: [] });
  });

  it("⭐ voltar ao padrão (null) APAGA a chave e preserva o resto", async () => {
    (tabela[0]!.settings as Linha).card_lines = ["email"];
    const r = await chamar({ card_lines: null });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({
      card_lines: ["ultima_mensagem", "telefone"],
      padrao: true,
    });
    expect(tabela[0]!.settings).toEqual({
      fields: [{ key: "x" }],
      atalhos: [{ rotulo: "a" }],
      ocultar_encerrados_dias: 30,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { card_lines: null, voltou_ao_padrao: true } }),
    );
  });

  it.each([
    ["duplicado", { card_lines: ["email", "email"] }],
    ["mais de 5", { card_lines: ["email", "cargo", "empresa", "origem", "telefone", "utm_source"] }],
    ["campo fora do vocabulário", { card_lines: ["cpf"] }],
    ["chave extra", { card_lines: [], settings: {} }],
    ["sem a chave", {}],
    ["JSON quebrado", "{"],
  ])("⭐ body inválido (%s) dá 400 e nada muda", async (_nome, body) => {
    const r = await chamar(body);
    expect(r.status).toBe(400);
    expect(tabela[0]!.settings).not.toHaveProperty("card_lines");
  });

  it("⭐ a organização vem da SESSÃO: funil de outra organização dá 404 e não muda", async () => {
    const r = await chamar({ card_lines: ["email"] }, FUNIL_DA_OUTRA);
    expect(r.status).toBe(404);
    expect(tabela[1]!.settings).toEqual({ fields: [] });
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "pipeline.card_lines_updated" }));
  });

  it("acompanhamento só leitura (suporte) é barrado antes do efeito", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(new Response(null, { status: 403 }) as never);
    expect((await chamar({ card_lines: ["email"] })).status).toBe(403);
    expect(tabela[0]!.settings).not.toHaveProperty("card_lines");
  });
});
