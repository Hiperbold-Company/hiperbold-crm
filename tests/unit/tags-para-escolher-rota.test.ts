import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/v1/tags/para-escolher — a lista de etiquetas do editor de tags do
 * contato. Alcança quem ATENDE (viewer), lê a organização da sessão e devolve na
 * ordem cadastrada, com cor e grupo.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const ORG = "org-1";

function banco(opts: {
  settings?: unknown;
  linhas?: unknown[];
  erroOrg?: { message: string } | null;
  erroRpc?: { message: string } | null;
}) {
  const rpc = vi.fn(async () => ({ data: opts.linhas ?? [], error: opts.erroRpc ?? null }));
  const eq = vi.fn(() => ({
    maybeSingle: async () => ({
      data: opts.erroOrg ? null : { settings: opts.settings ?? null },
      error: opts.erroOrg ?? null,
    }),
  }));
  const from = vi.fn(() => ({ select: () => ({ eq }) }));
  return { client: { from, rpc } as never, rpc, eq };
}

async function chama() {
  const { GET } = await import("@/app/api/v1/tags/para-escolher/route");
  const res = await GET();
  return { status: res.status, body: (await res.json()) as { data?: unknown[]; error?: unknown } };
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
  vi.mocked(requireRole).mockReset();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, name: "Org", role: "agent" },
  } as never);
});

describe("GET /api/v1/tags/para-escolher", () => {
  it("devolve o vocabulário na ordem cadastrada, com cor e grupo, e o que está em uso depois", async () => {
    const b = banco({
      settings: {
        tags: [
          { tag: "Novo Paciente", cor: "#ffb224", descricao: "Situação do paciente" },
          { tag: "Google Ads", cor: "#0091ff", descricao: "Origem do lead" },
        ],
      },
      // A função devolve em ordem alfabética: a rota não pode herdá-la.
      linhas: [
        { tag: "Google Ads", cor: "#0091ff", descricao: "Origem do lead" },
        { tag: "Novo Paciente", cor: "#ffb224", descricao: "Situação do paciente" },
        { tag: "vip", cor: null, descricao: null },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(b.client);

    const { status, body } = await chama();

    expect(status).toBe(200);
    expect(body.data).toEqual([
      { tag: "Novo Paciente", cor: "#ffb224", grupo: "Situação do paciente" },
      { tag: "Google Ads", cor: "#0091ff", grupo: "Origem do lead" },
      { tag: "vip", cor: null, grupo: null },
    ]);
    // A organização vem da sessão, nas duas leituras.
    expect(b.eq).toHaveBeenCalledWith("id", ORG);
    expect(b.rpc).toHaveBeenCalledWith("fn_vocabulario_de_tags", { p_org: ORG });
  });

  it("pede o papel viewer (quem atende), não manager", async () => {
    vi.mocked(createClient).mockResolvedValue(banco({}).client);
    await chama();
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.objectContaining({ resource: "settings_tags" }));
  });

  it("organização sem vocabulário nem uso: lista vazia, 200", async () => {
    vi.mocked(createClient).mockResolvedValue(banco({}).client);
    const { status, body } = await chama();
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("sem permissão devolve a resposta do portão e não lê nada", async () => {
    const negado = new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 });
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: negado } as never);
    const { status } = await chama();
    expect(status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("a falha sobe como 500 (lista vazia mentiria), nas duas leituras", async () => {
    vi.mocked(createClient).mockResolvedValue(banco({ erroRpc: { message: "boom" } }).client);
    expect((await chama()).status).toBe(500);
    vi.mocked(createClient).mockResolvedValue(banco({ erroOrg: { message: "boom" } }).client);
    expect((await chama()).status).toBe(500);
  });
});
