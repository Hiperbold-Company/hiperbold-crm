/**
 * Tools MCP da API fase 2: papel/escopo = o da rota/tela equivalente, catálogo 1:1, só humano, e o
 * comportamento das que mexem em segredo e em campos personalizados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalogo";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FUNIL = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FONTE = "11111111-1111-4111-8111-111111111111";

const ESPERADO: Record<string, { role: string; scope: string }> = {
  crm_rotate_webhook_source_secret: { role: "manager", scope: "mcp:write" },
  crm_list_pipeline_fields: { role: "manager", scope: "mcp:read" },
  crm_create_pipeline_field: { role: "admin", scope: "mcp:write" },
  crm_update_pipeline_field: { role: "admin", scope: "mcp:write" },
  crm_delete_pipeline_field: { role: "admin", scope: "mcp:write" },
  crm_list_ai_agents: { role: "manager", scope: "mcp:read" },
  crm_get_ai_agent: { role: "manager", scope: "mcp:read" },
  crm_create_ai_agent: { role: "admin", scope: "mcp:write" },
  crm_create_ai_agent_version: { role: "admin", scope: "mcp:write" },
  crm_publish_ai_agent_version: { role: "admin", scope: "mcp:write" },
  crm_pause_ai_agent: { role: "admin", scope: "mcp:write" },
};

const tool = (nome: string) => allTools.find((t) => t.name === nome)!;

/** Banco falso mínimo para o handler: devolve as linhas por tabela e registra as escritas. */
function ctxComBanco(linhas: Record<string, unknown>) {
  const escritas: Array<{ tabela: string; patch: unknown; filtros: Record<string, unknown> }> = [];
  const from = (tabela: string) => {
    const f: Record<string, unknown> = {};
    let patch: unknown;
    let op = "select";
    let emLista = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {
      select: () => c,
      update: (p: unknown) => ((op = "update"), (patch = p), c),
      insert: (p: unknown) => ((op = "insert"), (patch = p), c),
      eq: (k: string, v: unknown) => ((f[k] = v), c),
      in: () => ((emLista = true), c),
      is: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: async () => done(),
      single: async () => done(),
      then: (r: (v: unknown) => unknown) => Promise.resolve(done(true)).then(r),
    };
    const done = (lista = false) => {
      if (op !== "select") escritas.push({ tabela, patch, filtros: { ...f } });
      const dado = linhas[`${tabela}:${op}`] ?? linhas[tabela] ?? null;
      if (emLista && dado && !Array.isArray(dado)) return { data: [dado], error: null };
      return { data: lista || !Array.isArray(dado) ? dado : (dado[0] ?? null), error: null };
    };
    return c;
  };
  const supabase = { from, rpc: async () => ({ data: "\\xcifrado", error: null }) };
  vi.mocked(createAdminClient).mockReturnValue(supabase as never);
  const ctx = {
    organizationId: ORG,
    role: "admin",
    actor: { type: "api_token", id: TOKEN, role: "admin" },
    apiTokenId: TOKEN,
    requestId: "req-1",
    supabase,
  } as unknown as McpContext;
  return { ctx, escritas };
}

beforeEach(() => vi.clearAllMocks());

describe("tools MCP de administração — fase 2", () => {
  it.each(Object.entries(ESPERADO))("%s: papel e escopo da rota equivalente, no catálogo, só humano", (nome, e) => {
    const t = tool(nome);
    expect(t, `${nome} não registrada`).toBeTruthy();
    expect(t.requiresRole).toBe(e.role);
    expect(t.requiresScope).toBe(e.scope);
    const entrada = TOOL_CATALOG.find((x) => x.name === nome);
    expect(entrada, `${nome} fora do catálogo`).toBeTruthy();
    expect(entrada!.category).toBe(t.category);
    expect(entrada!.apenasHumano).toBe(true);
  });

  it("crm_create_webhook_source: o segredo digitado NÃO vai para os args do audit", () => {
    const redigido = tool("crm_create_webhook_source").redigirParaAuditoria?.({ name: "x", secret: "segredo-digitado-123" });
    expect(JSON.stringify(redigido)).not.toContain("segredo-digitado-123");
    expect(redigido).toMatchObject({ name: "x" });
  });

  it("crm_rotate_webhook_source_secret: devolve o segredo uma vez, grava só o cifrado e filtra pela organização", async () => {
    const fonte = {
      id: FONTE, name: "Site", is_active: true, path_token: "tok", secret_encrypted: "\\xcifrado",
      default_pipeline_id: FUNIL, default_stage_id: FUNIL, field_map: {},
    };
    const { ctx, escritas } = ctxComBanco({ webhook_sources: fonte });
    const r = (await tool("crm_rotate_webhook_source_secret").handler({ source_id: FONTE }, ctx)) as {
      secret: string;
      secret_shown_once: boolean;
    };
    expect(r.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(r.secret_shown_once).toBe(true);
    const escrita = escritas.find((e) => e.tabela === "webhook_sources");
    expect(escrita?.filtros).toMatchObject({ id: FONTE, organization_id: ORG });
    expect(JSON.stringify(escrita?.patch)).not.toContain(r.secret);
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(r.secret);
  });

  it("crm_create_pipeline_field: valida pelo schema (select sem opções → 422) e acrescenta sem apagar os outros", async () => {
    const { ctx, escritas } = ctxComBanco({
      crm_pipelines: { id: FUNIL, name: "V", vocabulary: {}, settings: { fields: [{ key: "a", label: "A", type: "text" }] } },
      "crm_pipelines:update": [{ id: FUNIL }],
    });
    await expect(
      tool("crm_create_pipeline_field").handler({ pipeline_id: FUNIL, key: "porte", label: "Porte", type: "select" }, ctx),
    ).rejects.toMatchObject({ status: 422 });
    expect(escritas).toEqual([]);

    await tool("crm_create_pipeline_field").handler({ pipeline_id: FUNIL, key: "b", label: "B", type: "boolean" }, ctx);
    const escrita = escritas.find((e) => e.tabela === "crm_pipelines");
    expect(escrita?.filtros).toMatchObject({ id: FUNIL, organization_id: ORG });
    expect((escrita?.patch as { settings: { fields: unknown[] } }).settings.fields).toHaveLength(2);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorApiTokenId: TOKEN, organizationId: ORG }));
  });

  it("crm_pause_ai_agent: agente de outra organização → 404 sem escrita", async () => {
    const { ctx, escritas } = ctxComBanco({});
    await expect(tool("crm_pause_ai_agent").handler({ agent_id: FUNIL }, ctx)).rejects.toMatchObject({ status: 404 });
    expect(escritas).toEqual([]);
  });
});
