/**
 * Seguimento do #3056 — a lista de problemas do arquivo recusado sai no idioma
 * de quem importa, com o caminho até o campo. Antes saía em inglês do Zod
 * («Invalid UUID»). O arquivo inválido é recusado antes de qualquer leitura do
 * banco, então os clients nem são chamados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), support: vi.fn(), audit: vi.fn(), client: vi.fn(), admin: vi.fn(), modulo: vi.fn(), conta: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));
vi.mock("@/lib/followup/portabilidade-db", () => ({ contextoDaConta: deps.conta }));

import { POST } from "./route";

const comoQuem = (idioma: "pt-BR" | "es") =>
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "manager" },
  });

const importar = (file: unknown) =>
  POST(
    new NextRequest("http://localhost/api/v1/ai/followup-flows/import", {
      method: "POST",
      body: JSON.stringify({ file }),
      headers: { "content-type": "application/json" },
    }),
  );

const ARQUIVO_SEM_GRAFO = { format: "followup_flow", version: 1, flow: { name: "X" } };

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
});

describe("POST /followup-flows/import — problemas no idioma de quem importa", () => {
  it.each([
    ["pt-BR", 'flow.graph: Entrada inválida: esperava um objeto, recebeu um valor "undefined"'],
    ["es", "flow.graph: Entrada inválida: se esperaba objeto, recibido indefinido"],
  ] as const)("%s", async (idioma, linha) => {
    comoQuem(idioma);
    const res = await importar(ARQUIVO_SEM_GRAFO);
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; details: { problemas: string[] } } };
    expect(corpo.error.code).toBe("invalid_flow_file");
    expect(corpo.error.details.problemas).toEqual([linha]);
    expect(deps.client).not.toHaveBeenCalled();
    expect(deps.admin).not.toHaveBeenCalled();
  });
});

describe("POST /followup-flows/import — o corpo do pedido também lê no idioma de quem importa", () => {
  it.each([
    ["pt-BR", "name: Entrada inválida: esperava um texto, recebeu um número"],
    ["es", "name: Entrada inválida: se esperaba texto, recibido número"],
  ] as const)("%s", async (idioma, linha) => {
    comoQuem(idioma);
    const res = await POST(
      new NextRequest("http://localhost/api/v1/ai/followup-flows/import", {
        method: "POST",
        body: JSON.stringify({ file: ARQUIVO_SEM_GRAFO, name: 5 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; details: { problemas: string[] } } };
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.details.problemas).toEqual([linha]);
  });
});

describe("POST /followup-flows/import — o gatilho de plano recusa com PT402", () => {
  const pos = { x: 0, y: 0 };
  const arquivoValido = () => ({
    format: "followup_flow",
    version: 1,
    flow: {
      name: "Automação do arquivo",
      surface: "automacao",
      handoff_policy: "pause",
      trigger_config: { kind: "manual" },
      graph: {
        nodes: [
          { id: "t1", type: "trigger", label: "Início", position: pos, config: {} },
          { id: "e1", type: "end", label: "Fim", position: pos, config: { outcome: "exhausted" } },
        ],
        edges: [{ id: "x0", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
      },
    },
  });

  const clienteQueRecusa = (erro: { code: string; message: string; details?: string }) => ({
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error: erro }) }) }),
    }),
  });

  beforeEach(() => {
    deps.conta.mockResolvedValue({
      stages: new Map(),
      templates: new Map(),
      users: new Set(),
      flows: new Map(),
      event_types: new Map(),
    });
    // Leitura do limite falha: a mensagem cai na frase sem número, que continua verdadeira.
    deps.admin.mockReturnValue({
      from: () => {
        throw new Error("sem leitura");
      },
    });
  });

  it("PT402 do teto de automações vira 402 plano_limite_atingido, nunca erro interno", async () => {
    comoQuem("pt-BR");
    deps.client.mockResolvedValue(
      clienteQueRecusa({ code: "PT402", message: "Limite do plano atingido", details: "automacoes" }),
    );
    const res = await importar(arquivoValido());
    expect(res.status).toBe(402);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("plano_limite_atingido");
    expect(corpo.error.message).toBe(
      "Seu plano chegou ao limite de automações. Mude de plano para criar mais.",
    );
    expect(corpo.error.message).not.toContain("Limite do plano atingido");
  });

  it("PT402 de conta suspensa também é 402", async () => {
    comoQuem("pt-BR");
    deps.client.mockResolvedValue(
      clienteQueRecusa({ code: "PT402", message: "Conta suspensa", details: "assinatura_suspensa" }),
    );
    const res = await importar(arquivoValido());
    expect(res.status).toBe(402);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("plano_limite_atingido");
  });

  it("outro erro do banco segue como 500", async () => {
    comoQuem("pt-BR");
    deps.client.mockResolvedValue(clienteQueRecusa({ code: "XX000", message: "boom" }));
    const res = await importar(arquivoValido());
    expect(res.status).toBe(500);
  });
});
