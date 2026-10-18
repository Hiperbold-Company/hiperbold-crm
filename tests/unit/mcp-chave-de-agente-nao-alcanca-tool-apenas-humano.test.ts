import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Porta MCP externa: chave de AGENTE DE IA (`actor.type === "ai_agent"`) não
 * alcança tool `apenasHumano` do catálogo (administração), nem de leitura nem
 * de escrita. Chave de pessoa/integração passa. As tools abaixo usam nomes REAIS
 * do catálogo: quem decide é `catalogEntry`, não um dublê.
 */
const auditSpy = vi.fn();
const handlerSpy = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/mcp/rate-limit", () => ({ verificarTetoMcp: async () => undefined }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

vi.mock("@/lib/mcp/tools", () => ({
  allTools: [
    {
      name: "crm_list_followup_flows",
      description: "leitura de administração",
      inputSchema: { termo: z.string().optional() },
      requiresRole: "viewer",
      requiresScope: "mcp:read",
      category: "read",
      handler: (...a: unknown[]) => handlerSpy(...a),
    },
    {
      name: "crm_create_followup_flow",
      description: "escrita de administração",
      inputSchema: { termo: z.string().optional() },
      requiresRole: "viewer",
      requiresScope: "mcp:write",
      category: "write",
      handler: (...a: unknown[]) => handlerSpy(...a),
    },
    {
      name: "crm_create_stage",
      description: "escrita de operação (W4): apenasHumano, mas é do agente com papel",
      inputSchema: {},
      requiresRole: "viewer",
      requiresScope: "mcp:write",
      category: "write",
      handler: (...a: unknown[]) => handlerSpy(...a),
    },
    {
      name: "tool_comum_do_catalogo",
      description: "não é apenasHumano",
      inputSchema: {},
      requiresRole: "viewer",
      requiresScope: "mcp:read",
      category: "read",
      handler: (...a: unknown[]) => handlerSpy(...a),
    },
  ],
}));

const { createMcpServer } = await import("@/lib/mcp/server");
const { catalogEntry } = await import("@/lib/mcp/tools/catalog");

type Ator = Parameters<typeof createMcpServer>[0]["actor"];

async function chamar(actor: Ator, tool: string) {
  const server = createMcpServer(
    {
      organizationId: "00000000-0000-4000-8000-000000000001",
      role: "admin",
      actor,
      apiTokenId: "tok",
      scopes: ["mcp:read", "mcp:write"],
    },
    "req-1",
  );
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  const r = await client.callTool({ name: tool, arguments: {} });
  await client.close();
  return r as { isError?: boolean; content: Array<{ text: string }> };
}

const agenteDeIa = { type: "ai_agent", id: "run-1", role: "admin", api_token_id: "tok" } as Ator;
const chaveHumana = { type: "api_token", id: "tok", role: "admin" } as Ator;

beforeEach(() => {
  auditSpy.mockClear();
  handlerSpy.mockClear();
});

describe("MCP: chave de agente de IA e tool apenasHumano", () => {
  it("controle: as duas tools de administração SÃO apenasHumano no catálogo", () => {
    expect(catalogEntry("crm_list_followup_flows")?.apenasHumano).toBe(true);
    expect(catalogEntry("crm_create_followup_flow")?.apenasHumano).toBe(true);
    expect(catalogEntry("tool_comum_do_catalogo")).toBeUndefined();
  });

  it("agente de IA chamando leitura apenasHumano é recusado ANTES do handler", async () => {
    const r = await chamar(agenteDeIa, "crm_list_followup_flows");
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/person only/);
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it("agente de IA chamando escrita apenasHumano é recusado ANTES do handler", async () => {
    const r = await chamar(agenteDeIa, "crm_create_followup_flow");
    expect(r.isError).toBe(true);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it("chave humana/de integração passa nas duas", async () => {
    const leitura = await chamar(chaveHumana, "crm_list_followup_flows");
    const escrita = await chamar(chaveHumana, "crm_create_followup_flow");
    expect(leitura.isError).toBeFalsy();
    expect(escrita.isError).toBeFalsy();
    expect(handlerSpy).toHaveBeenCalledTimes(2);
  });

  it("escrita de OPERAÇÃO apenasHumano (crm_create_stage) segue alcançável pelo agente: quem barra é o papel (W4)", async () => {
    const { eToolDeAdministracao } = await import("@/lib/mcp/tools/catalog");
    expect(catalogEntry("crm_create_stage")?.apenasHumano).toBe(true);
    expect(eToolDeAdministracao("crm_create_stage")).toBe(false);
    expect(eToolDeAdministracao("crm_create_followup_flow")).toBe(true);
    const r = await chamar(agenteDeIa, "crm_create_stage");
    expect(r.isError).toBeFalsy();
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("agente de IA segue alcançando tool que NÃO é apenasHumano", async () => {
    const r = await chamar(agenteDeIa, "tool_comum_do_catalogo");
    expect(r.isError).toBeFalsy();
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });
});
