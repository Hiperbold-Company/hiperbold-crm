/**
 * A lista de canais (GET /api/v1/channel-sessions) é lida por QUALQUER membro,
 * inclusive `viewer`. O #2318 passou a selecionar `metadata` para a tela saber
 * se o canal está pausado — e com ela iam os números de teste da IA e o resto
 * da configuração interna do canal. A resposta leva só `disabled`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const linhas = [
  {
    id: "c1",
    provider: "waha",
    metadata: {
      disabled: true,
      ai_gate: "allowlist",
      ai_gate_mode: "pre_go_live",
      ai_test_phone_numbers: ["+5511999990000"],
      guardar_historico: true,
    },
  },
  { id: "c2", provider: "waha", metadata: null },
];

// A rota autoriza por `autorizarAdministracao` (sessão OU token, `viewer`+): o dublê é essa
// porta, devolvendo um membro `viewer` e o cliente do banco já escopado.
vi.mock("@/lib/api/auth-dual-admin", () => {
  // O cliente NÃO pode ser thenable; quem resolve é a consulta.
  const consulta: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "order"]) consulta[m] = () => consulta;
  consulta.then = (r: (v: unknown) => unknown) =>
    Promise.resolve({ data: linhas, error: null }).then(r);
  return {
    autorizarAdministracao: vi.fn(async () => ({
      ok: true,
      via: "session",
      actor: { type: "user", id: "u1", role: "viewer" },
      organizationId: "org-1",
      idioma: "pt-BR",
      supabase: { from: () => consulta },
      apiTokenId: undefined,
    })),
  };
});

describe("GET /api/v1/channel-sessions — a lista de qualquer membro", () => {
  beforeEach(() => vi.clearAllMocks());

  it("devolve só o `disabled` da metadata, nunca a configuração interna do canal", async () => {
    const { GET } = await import("@/app/api/v1/channel-sessions/route");
    const res = await GET(new NextRequest("http://x/api/v1/channel-sessions"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ id: string; metadata: unknown }> };
    expect(corpo.data.map((c) => c.metadata)).toEqual([{ disabled: true }, { disabled: false }]);
    expect(JSON.stringify(corpo)).not.toContain("+5511999990000");
  });
});
