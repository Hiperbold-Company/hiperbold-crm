/**
 * Tools MCP da API fase 3: papel/escopo = o da rota/tela equivalente, catálogo 1:1, só humano, e o
 * comportamento das que escrevem (organização sempre a da chave, audit com o token).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalogo";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/embeddings/chave", () => ({ temChaveDeEmbedding: vi.fn(async () => true) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  peekRateLimit: vi.fn(async () => 0),
}));
vi.mock("@/lib/team/convites", () => ({
  emitirConvite: vi.fn(async () => ({
    convite: { id: "convite-1", expires_at: "2026-10-24T00:00:00Z" },
    accept_url: "https://crm.exemplo/accept?t=SEGREDO-DO-LINK",
    email_dispatched: true,
  })),
}));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({ registrarTrocaDeComando: vi.fn(async () => undefined) }));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DONO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MODELO = "11111111-1111-4111-8111-111111111111";

const ESPERADO: Record<string, { role: string; scope: string }> = {
  crm_create_message_template: { role: "manager", scope: "mcp:write" },
  crm_update_message_template: { role: "manager", scope: "mcp:write" },
  crm_delete_message_template: { role: "manager", scope: "mcp:write" },
  crm_list_followup_flows: { role: "manager", scope: "mcp:read" },
  crm_get_followup_flow: { role: "manager", scope: "mcp:read" },
  crm_create_followup_flow: { role: "manager", scope: "mcp:write" },
  crm_update_followup_flow: { role: "manager", scope: "mcp:write" },
  crm_delete_followup_flow: { role: "manager", scope: "mcp:write" },
  crm_duplicate_followup_flow: { role: "manager", scope: "mcp:write" },
  crm_publish_followup_flow: { role: "manager", scope: "mcp:write" },
  crm_disable_followup_flow: { role: "manager", scope: "mcp:write" },
  crm_rollback_followup_flow: { role: "manager", scope: "mcp:write" },
  crm_list_ai_routers: { role: "manager", scope: "mcp:read" },
  crm_get_ai_router: { role: "manager", scope: "mcp:read" },
  crm_create_ai_router: { role: "admin", scope: "mcp:write" },
  crm_update_ai_router: { role: "admin", scope: "mcp:write" },
  crm_delete_ai_router: { role: "admin", scope: "mcp:write" },
  crm_set_ai_router_members: { role: "admin", scope: "mcp:write" },
  crm_create_automation_rule: { role: "manager", scope: "mcp:write" },
  crm_update_automation_rule: { role: "manager", scope: "mcp:write" },
  crm_delete_automation_rule: { role: "manager", scope: "mcp:write" },
  crm_get_attendance_routing: { role: "manager", scope: "mcp:read" },
  crm_update_attendance_routing: { role: "manager", scope: "mcp:write" },
  crm_get_knowledge_source: { role: "manager", scope: "mcp:read" },
  crm_create_knowledge_source: { role: "manager", scope: "mcp:write" },
  crm_update_knowledge_source: { role: "manager", scope: "mcp:write" },
  crm_archive_knowledge_source: { role: "manager", scope: "mcp:write" },
  crm_invite_team_members: { role: "admin", scope: "mcp:write" },
  crm_change_team_member_role: { role: "admin", scope: "mcp:write" },
  crm_revoke_team_member: { role: "admin", scope: "mcp:write" },
  crm_reactivate_team_member: { role: "admin", scope: "mcp:write" },
  crm_create_pipeline: { role: "manager", scope: "mcp:write" },
  crm_update_pipeline: { role: "manager", scope: "mcp:write" },
  crm_delete_pipeline: { role: "manager", scope: "mcp:write" },
  crm_list_channel_sessions: { role: "manager", scope: "mcp:read" },
  crm_list_ai_credentials: { role: "manager", scope: "mcp:read" },
};

const tool = (nome: string) => allTools.find((t) => t.name === nome)!;

/** Banco falso mínimo para o handler: devolve as linhas por tabela e registra as escritas. */
function ctxComBanco(linhas: Record<string, unknown>) {
  const escritas: Array<{ tabela: string; op: string; patch: unknown; filtros: Record<string, unknown> }> = [];
  const from = (tabela: string) => {
    const f: Record<string, unknown> = {};
    let patch: unknown;
    let op = "select";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {
      select: () => c,
      update: (p: unknown) => ((op = "update"), (patch = p), c),
      insert: (p: unknown) => ((op = "insert"), (patch = p), c),
      delete: () => ((op = "delete"), c),
      eq: (k: string, v: unknown) => ((f[k] = v), c),
      is: (k: string, v: unknown) => ((f[`is:${k}`] = v), c),
      neq: () => c,
      in: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: async () => done(),
      single: async () => done(),
      then: (r: (v: unknown) => unknown) => Promise.resolve(done(true)).then(r),
    };
    const done = (lista = false) => {
      if (op !== "select") escritas.push({ tabela, op, patch, filtros: { ...f } });
      const dado = linhas[`${tabela}:${op}`] ?? linhas[tabela] ?? null;
      const contagem = Array.isArray(dado) ? dado.length : dado ? 1 : 0;
      return { data: lista || !Array.isArray(dado) ? dado : (dado[0] ?? null), error: null, count: contagem };
    };
    return c;
  };
  const supabase = {
    from,
    rpc: async () => ({ data: "\\xcifrado", error: null }),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: "membro@exemplo.com" } } }) } },
  };
  const ctx = {
    organizationId: ORG,
    role: "manager",
    actor: { type: "api_token", id: TOKEN, role: "manager" },
    apiTokenId: TOKEN,
    requestId: "req-1",
    supabase,
  } as unknown as McpContext;
  return { ctx, escritas };
}

beforeEach(() => vi.clearAllMocks());

describe("tools MCP de administração — fase 3", () => {
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

  describe("respostas prontas", () => {
    const linha = { id: MODELO, organization_id: ORG, owner_user_id: null, title: "T", body: "B" };

    it("crm_create_message_template: sempre compartilhada, na organização da chave, com a pessoa dona da chave", async () => {
      const { ctx, escritas } = ctxComBanco({
        api_tokens: { created_by: DONO },
        message_templates: linha,
      });
      await tool("crm_create_message_template").handler({ title: "T", body: "B" }, ctx);
      const insert = escritas.find((e) => e.tabela === "message_templates" && e.op === "insert");
      expect(insert?.patch).toMatchObject({ organization_id: ORG, owner_user_id: null, created_by_user_id: DONO });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "template.created", actorApiTokenId: TOKEN, organizationId: ORG }),
      );
    });

    it("crm_create_message_template: chave sem dono identificável → 403, nada escrito", async () => {
      const { ctx, escritas } = ctxComBanco({ api_tokens: { created_by: null } });
      await expect(tool("crm_create_message_template").handler({ title: "T", body: "B" }, ctx)).rejects.toMatchObject({
        status: 403,
      });
      expect(escritas).toEqual([]);
    });

    it("crm_update_message_template: filtra por organização e só compartilhadas; outra organização → 404; vazio → 422", async () => {
      const { ctx, escritas } = ctxComBanco({ message_templates: linha });
      await tool("crm_update_message_template").handler({ template_id: MODELO, title: "N" }, ctx);
      expect(escritas[0]!.filtros).toMatchObject({ id: MODELO, organization_id: ORG, "is:owner_user_id": null });

      await expect(tool("crm_update_message_template").handler({ template_id: MODELO }, ctx)).rejects.toMatchObject({
        status: 422,
      });
      const outro = ctxComBanco({});
      await expect(
        tool("crm_update_message_template").handler({ template_id: MODELO, title: "N" }, outro.ctx),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("crm_delete_message_template: apaga só compartilhada da organização da chave; inexistente → 404", async () => {
      const { ctx, escritas } = ctxComBanco({ message_templates: { id: MODELO } });
      const r = await tool("crm_delete_message_template").handler({ template_id: MODELO }, ctx);
      expect(r).toMatchObject({ id: MODELO, deleted: true });
      expect(escritas[0]).toMatchObject({ op: "delete" });
      expect(escritas[0]!.filtros).toMatchObject({ id: MODELO, organization_id: ORG, "is:owner_user_id": null });

      const vazio = ctxComBanco({});
      await expect(tool("crm_delete_message_template").handler({ template_id: MODELO }, vazio.ctx)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe("fluxos de follow-up", () => {
    const FLUXO = "22222222-2222-4222-8222-222222222222";
    const ponteiro = { id: FLUXO, name: "Retorno", status: "draft", draft_graph: null, trigger_config: { kind: "manual" } };

    it("crm_create_followup_flow: grava na organização da chave e audita com o token; nome vazio → 422", async () => {
      const { ctx, escritas } = ctxComBanco({ followup_flow_pointers: ponteiro });
      await tool("crm_create_followup_flow").handler({ name: "Retorno" }, ctx);
      const insert = escritas.find((e) => e.op === "insert");
      expect(insert?.patch).toMatchObject({ organization_id: ORG, name: "Retorno" });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "followup_flow.created", actorApiTokenId: TOKEN, organizationId: ORG }),
      );
      await expect(tool("crm_create_followup_flow").handler({ name: "" }, ctx)).rejects.toMatchObject({ status: 422 });
    });

    it("crm_update_followup_flow: filtra pela organização; gatilho inválido → 422 sem escrita; outra organização → 404", async () => {
      const { ctx, escritas } = ctxComBanco({ followup_flow_pointers: ponteiro });
      await tool("crm_update_followup_flow").handler({ flow_id: FLUXO, name: "Novo" }, ctx);
      const upd = escritas.find((e) => e.op === "update");
      expect(upd?.filtros).toMatchObject({ id: FLUXO, organization_id: ORG });

      const ruim = ctxComBanco({ followup_flow_pointers: ponteiro });
      await expect(
        tool("crm_update_followup_flow").handler({ flow_id: FLUXO, trigger_config: { kind: "inventado" } }, ruim.ctx),
      ).rejects.toMatchObject({ status: 422 });
      expect(ruim.escritas).toEqual([]);

      const outro = ctxComBanco({});
      await expect(
        tool("crm_update_followup_flow").handler({ flow_id: FLUXO, name: "N" }, outro.ctx),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("crm_delete_followup_flow: apaga inscrições, versões e fluxo da organização da chave; fora dela → 404 sem apagar", async () => {
      const { ctx, escritas } = ctxComBanco({ followup_flow_pointers: ponteiro });
      const r = await tool("crm_delete_followup_flow").handler({ flow_id: FLUXO }, ctx);
      expect(r).toMatchObject({ id: FLUXO, deleted: true });
      const apagou = escritas.filter((e) => e.op === "delete");
      expect(apagou.map((e) => e.tabela)).toEqual(["followup_enrollments", "followup_flow_versions", "followup_flow_pointers"]);
      expect(apagou.every((e) => e.filtros.organization_id === ORG)).toBe(true);

      const outro = ctxComBanco({});
      await expect(tool("crm_delete_followup_flow").handler({ flow_id: FLUXO }, outro.ctx)).rejects.toMatchObject({
        status: 404,
      });
      expect(outro.escritas).toEqual([]);
    });

    it("crm_publish_followup_flow: sem dono identificável na chave → 403, sem publicar; sem rascunho → 422", async () => {
      const semDono = ctxComBanco({ api_tokens: { created_by: null }, followup_flow_pointers: ponteiro });
      await expect(tool("crm_publish_followup_flow").handler({ flow_id: FLUXO }, semDono.ctx)).rejects.toMatchObject({
        status: 403,
      });
      const semRascunho = ctxComBanco({ api_tokens: { created_by: DONO }, followup_flow_pointers: ponteiro });
      await expect(
        tool("crm_publish_followup_flow").handler({ flow_id: FLUXO }, semRascunho.ctx),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("roteadores de intenção", () => {
    const ROTEADOR = "44444444-4444-4444-8444-444444444444";
    const SESSAO = "55555555-5555-4555-8555-555555555555";
    const AGENTE = "66666666-6666-4666-8666-666666666666";

    it("crm_create_ai_router: grava na organização da chave com a pessoa dona e audita com o token; sem dono → 403", async () => {
      const { ctx, escritas } = ctxComBanco({
        api_tokens: { created_by: DONO },
        channel_sessions: { id: SESSAO },
        ai_routers: { id: ROTEADOR },
      });
      await tool("crm_create_ai_router").handler({ name: "Entrada", channel_session_id: SESSAO }, ctx);
      expect(escritas.find((e) => e.tabela === "ai_routers" && e.op === "insert")?.patch).toMatchObject({
        organization_id: ORG,
        created_by: DONO,
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ai.router_created", actorApiTokenId: TOKEN, organizationId: ORG }),
      );

      const semDono = ctxComBanco({ api_tokens: { created_by: null }, channel_sessions: { id: SESSAO } });
      await expect(
        tool("crm_create_ai_router").handler({ name: "Entrada", channel_session_id: SESSAO }, semDono.ctx),
      ).rejects.toMatchObject({ status: 403 });
      expect(semDono.escritas).toEqual([]);
    });

    it("crm_create_ai_router: número de outra organização → 404 sem escrita", async () => {
      const { ctx, escritas } = ctxComBanco({ api_tokens: { created_by: DONO } });
      await expect(
        tool("crm_create_ai_router").handler({ name: "Entrada", channel_session_id: SESSAO }, ctx),
      ).rejects.toMatchObject({ status: 404 });
      expect(escritas).toEqual([]);
    });

    it("crm_update_ai_router / crm_delete_ai_router: filtram pela organização; outro roteador → 404", async () => {
      const { ctx, escritas } = ctxComBanco({ ai_routers: { id: ROTEADOR, config: {} } });
      await tool("crm_update_ai_router").handler({ router_id: ROTEADOR, is_active: false }, ctx);
      await tool("crm_delete_ai_router").handler({ router_id: ROTEADOR }, ctx);
      expect(escritas.map((e) => e.op)).toEqual(["update", "delete"]);
      expect(escritas.every((e) => e.filtros.organization_id === ORG && e.filtros.id === ROTEADOR)).toBe(true);

      const outro = ctxComBanco({});
      await expect(
        tool("crm_update_ai_router").handler({ router_id: ROTEADOR, name: "N" }, outro.ctx),
      ).rejects.toMatchObject({ status: 404 });
      await expect(tool("crm_delete_ai_router").handler({ router_id: ROTEADOR }, outro.ctx)).rejects.toMatchObject({
        status: 404,
      });
      expect(outro.escritas).toEqual([]);
    });

    it("crm_set_ai_router_members: intenção duplicada → 409 e nada gravado", async () => {
      vi.stubEnv("SUPABASE_DB_URL", "");
      const { ctx, escritas } = ctxComBanco({ ai_routers: { id: ROTEADOR }, ai_agents: [{ id: AGENTE }] });
      const membro = { agent_id: AGENTE, intent_name: "Vendas", intent_description: "Quer comprar" };
      await expect(
        tool("crm_set_ai_router_members").handler({ router_id: ROTEADOR, members: [membro, membro] }, ctx),
      ).rejects.toMatchObject({ status: 409 });
      expect(escritas).toEqual([]);
      vi.unstubAllEnvs();
    });
  });

  describe("regras automáticas", () => {
    const REGRA = "77777777-7777-4777-8777-777777777777";
    const SEGREDO = "segredo-do-webhook-em-texto-claro-9";
    const acoes = [{ type: "call_webhook", config: { url: "https://exemplo.com/h", secret: SEGREDO } }];

    it("o segredo de call_webhook não vai para o audit da chamada da tool", () => {
      for (const nome of ["crm_create_automation_rule", "crm_update_automation_rule"]) {
        const redigido = tool(nome).redigirParaAuditoria?.({ name: "x", actions: acoes });
        expect(JSON.stringify(redigido), nome).not.toContain(SEGREDO);
        expect(redigido).toMatchObject({ name: "x" });
      }
    });

    it("crm_create_automation_rule: nasce na organização da chave, pausada, segredo cifrado e fora da resposta e do audit", async () => {
      const { ctx, escritas } = ctxComBanco({
        api_tokens: { created_by: DONO },
        automation_rules: {
          id: REGRA,
          is_active: false,
          actions: [{ type: "call_webhook", config: { url: "https://exemplo.com/h", secret_enc: "abcd" } }],
        },
      });
      const r = await tool("crm_create_automation_rule").handler(
        { name: "Avisar", trigger_event: "lead.created", actions: acoes },
        ctx,
      );
      const insert = escritas.find((e) => e.tabela === "automation_rules" && e.op === "insert");
      expect(insert?.patch).toMatchObject({ organization_id: ORG, created_by_user_id: DONO });
      expect(insert?.patch).not.toHaveProperty("is_active");
      expect(JSON.stringify(insert?.patch)).not.toContain(SEGREDO);
      expect(JSON.stringify(r)).not.toContain("secret_enc");
      expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(SEGREDO);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "automation.rule_created", actorApiTokenId: TOKEN, organizationId: ORG }),
      );
    });

    it("crm_create_automation_rule: regra inválida → 422 sem escrita", async () => {
      const { ctx, escritas } = ctxComBanco({ api_tokens: { created_by: DONO } });
      await expect(
        tool("crm_create_automation_rule").handler({ name: "x", trigger_event: "nao.existe", actions: acoes }, ctx),
      ).rejects.toMatchObject({ status: 422 });
      expect(escritas).toEqual([]);
    });

    it("crm_update_automation_rule / crm_delete_automation_rule: filtram pela organização; outra regra → 404", async () => {
      const { ctx, escritas } = ctxComBanco({ automation_rules: { id: REGRA, actions: [] } });
      await tool("crm_update_automation_rule").handler({ rule_id: REGRA, is_active: true }, ctx);
      await tool("crm_delete_automation_rule").handler({ rule_id: REGRA }, ctx);
      expect(escritas.map((e) => e.op)).toEqual(["update", "delete"]);
      expect(escritas.every((e) => e.filtros.organization_id === ORG && e.filtros.id === REGRA)).toBe(true);

      const outro = ctxComBanco({});
      await expect(
        tool("crm_update_automation_rule").handler({ rule_id: REGRA, name: "N" }, outro.ctx),
      ).rejects.toMatchObject({ status: 404 });
      await expect(tool("crm_delete_automation_rule").handler({ rule_id: REGRA }, outro.ctx)).rejects.toMatchObject({
        status: 404,
      });
      expect(outro.escritas).toEqual([]);
    });
  });

  describe("distribuição de atendimento", () => {
    it("crm_update_attendance_routing: o que não veio mantém o valor em vigor; grava só na organização da chave", async () => {
      const { ctx } = ctxComBanco({
        organizations: {
          id: ORG,
          settings: { visibility_mode: "own", routing: { mode: "round_robin", max_retries: 9, backoff_seconds: 30 } },
        },
      });
      const r = (await tool("crm_update_attendance_routing").handler({ backoff_seconds: 45 }, ctx)) as Record<string, unknown>;
      expect(r).toMatchObject({ mode: "round_robin", max_retries: 9, backoff_seconds: 45, visibility_mode: "own" });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "routing.config_changed", actorApiTokenId: TOKEN, organizationId: ORG }),
      );
    });

    it("crm_update_attendance_routing: sem nenhum campo → 422; modo inválido → 422; organização inexistente → 404", async () => {
      const { ctx } = ctxComBanco({ organizations: { id: ORG, settings: {} } });
      await expect(tool("crm_update_attendance_routing").handler({}, ctx)).rejects.toMatchObject({ status: 422 });
      await expect(
        tool("crm_update_attendance_routing").handler({ handoff_return_after_minutes: 1 }, ctx),
      ).rejects.toMatchObject({ status: 422 });
      const vazio = ctxComBanco({});
      await expect(
        tool("crm_update_attendance_routing").handler({ mode: "manual" }, vazio.ctx),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("material de conhecimento", () => {
    const FONTE = "88888888-8888-4888-8888-888888888888";
    const faq = { source_type: "faq", name: "FAQ da loja", items: [{ question: "Prazo?", answer: "Dois dias." }] };

    it("crm_create_knowledge_source: grava na organização da chave, com itens, e audita com o token", async () => {
      const { ctx, escritas } = ctxComBanco({ ai_knowledge_sources: { id: FONTE } });
      const r = (await tool("crm_create_knowledge_source").handler(faq, ctx)) as { id: string; items_count: number };
      expect(r).toMatchObject({ id: FONTE, items_count: 1, indexacao_habilitada: true });
      expect(escritas.find((e) => e.tabela === "ai_knowledge_sources" && e.op === "insert")?.patch).toMatchObject({
        organization_id: ORG,
        source_type: "faq",
      });
      expect(escritas.find((e) => e.tabela === "ai_faq_items")?.patch).toBeTruthy();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ai.knowledge_source_created", actorApiTokenId: TOKEN, organizationId: ORG }),
      );
    });

    it("crm_create_knowledge_source: tipo desconhecido e FAQ sem conteúdo são recusados sem escrita", async () => {
      const { ctx, escritas } = ctxComBanco({ ai_knowledge_sources: { id: FONTE } });
      await expect(
        tool("crm_create_knowledge_source").handler({ ...faq, source_type: "inventado" }, ctx),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        tool("crm_create_knowledge_source").handler({ source_type: "faq", name: "Vazia" }, ctx),
      ).rejects.toMatchObject({ status: 400 });
      expect(escritas).toEqual([]);
    });

    it("crm_update_knowledge_source / crm_archive_knowledge_source: filtram pela organização; outro material → 404", async () => {
      const { ctx, escritas } = ctxComBanco({ ai_knowledge_sources: { id: FONTE, source_type: "faq", agent_id: null } });
      await tool("crm_update_knowledge_source").handler({ source_id: FONTE, name: "Novo nome" }, ctx);
      const r = await tool("crm_archive_knowledge_source").handler({ source_id: FONTE }, ctx);
      expect(r).toMatchObject({ id: FONTE, status: "archived" });
      const arquivou = escritas.filter((e) => e.op === "update").at(-1);
      expect(arquivou?.patch).toMatchObject({ status: "archived", is_active: false });
      expect(arquivou?.filtros).toMatchObject({ id: FONTE, organization_id: ORG });

      const outro = ctxComBanco({});
      await expect(
        tool("crm_update_knowledge_source").handler({ source_id: FONTE, name: "Novo nome" }, outro.ctx),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        tool("crm_archive_knowledge_source").handler({ source_id: FONTE }, outro.ctx),
      ).rejects.toMatchObject({ status: 404 });
      expect(outro.escritas).toEqual([]);
      await expect(tool("crm_update_knowledge_source").handler({ source_id: FONTE }, ctx)).rejects.toMatchObject({
        status: 422,
      });
    });
  });

  describe("equipe", () => {
    const MEMBRO = "abababab-abab-4bab-8bab-abababababab";
    const linhaDoMembro = { id: "vinculo-1", user_id: MEMBRO, role: "agent", revoked_at: null };

    it("crm_invite_team_members: o link de aceite NÃO volta; convida em nome do dono da chave; audit com o token", async () => {
      const { emitirConvite } = await import("@/lib/team/convites");
      const { ctx } = ctxComBanco({
        api_tokens: { created_by: DONO },
        organizations: { display_name: "Clínica X" },
        user_organizations: [],
      });
      const r = (await tool("crm_invite_team_members").handler(
        { invitations: [{ email: "Novo@Exemplo.com", role: "agent" }] },
        ctx,
      )) as { sent: Array<Record<string, unknown>>; failed: unknown[] };
      expect(r.sent).toHaveLength(1);
      expect(r.sent[0]).toMatchObject({ email: "novo@exemplo.com", invite_id: "convite-1" });
      expect(JSON.stringify(r)).not.toContain("SEGREDO-DO-LINK");
      expect(r.sent[0]).not.toHaveProperty("accept_url");
      expect(vi.mocked(emitirConvite).mock.calls[0]![1]).toMatchObject({
        organizationId: ORG,
        inviterId: DONO,
        actorApiTokenId: TOKEN,
        orgName: "Clínica X",
        role: "agent",
      });
    });

    it("crm_invite_team_members: quem já é membro volta em failed; e-mail inválido e papel inventado → 422 sem convite", async () => {
      const { emitirConvite } = await import("@/lib/team/convites");
      vi.mocked(emitirConvite).mockClear();
      const { ctx } = ctxComBanco({
        api_tokens: { created_by: DONO },
        organizations: { display_name: "Clínica X" },
        user_organizations: [{ user_id: MEMBRO }],
      });
      const r = (await tool("crm_invite_team_members").handler(
        { invitations: [{ email: "membro@exemplo.com", role: "agent" }] },
        ctx,
      )) as { sent: unknown[]; failed: Array<{ reason: string }> };
      expect(r.sent).toEqual([]);
      expect(r.failed[0]!.reason).toBe("already_member");
      expect(emitirConvite).not.toHaveBeenCalled();
      await expect(
        tool("crm_invite_team_members").handler({ invitations: [{ email: "nao-e-email", role: "agent" }] }, ctx),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        tool("crm_invite_team_members").handler({ invitations: [{ email: "a@b.com", role: "ai_operator" as never }] }, ctx),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("crm_change_team_member_role: grava na organização da chave e audita; membro de outra organização → 404; último admin → 409", async () => {
      const { ctx, escritas } = ctxComBanco({ api_tokens: { created_by: DONO }, user_organizations: linhaDoMembro });
      await tool("crm_change_team_member_role").handler({ user_id: MEMBRO, role: "manager" }, ctx);
      const upd = escritas.find((e) => e.op === "update");
      expect(upd?.patch).toMatchObject({ role: "manager" });
      expect(upd?.filtros).toMatchObject({ id: "vinculo-1", organization_id: ORG });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "team.role_changed", actorApiTokenId: TOKEN, organizationId: ORG }),
      );

      const outro = ctxComBanco({ api_tokens: { created_by: DONO } });
      await expect(
        tool("crm_change_team_member_role").handler({ user_id: MEMBRO, role: "manager" }, outro.ctx),
      ).rejects.toMatchObject({ status: 404 });
      expect(outro.escritas).toEqual([]);

      const unico = ctxComBanco({ api_tokens: { created_by: DONO }, user_organizations: { ...linhaDoMembro, role: "admin" } });
      await expect(
        tool("crm_change_team_member_role").handler({ user_id: MEMBRO, role: "agent" }, unico.ctx),
      ).rejects.toMatchObject({ status: 409 });
      expect(unico.escritas).toEqual([]);
    });

    it("crm_revoke_team_member: não revoga o dono da chave; revoga as chaves do membro na organização; fora dela → 404", async () => {
      const proprio = ctxComBanco({ api_tokens: { created_by: DONO }, user_organizations: { ...linhaDoMembro, user_id: DONO } });
      await expect(tool("crm_revoke_team_member").handler({ user_id: DONO }, proprio.ctx)).rejects.toMatchObject({
        status: 409,
      });
      expect(proprio.escritas).toEqual([]);

      const { ctx, escritas } = ctxComBanco({
        api_tokens: [{ created_by: DONO, id: "chave-do-membro" }],
        user_organizations: linhaDoMembro,
        conversations: [],
      });
      const r = (await tool("crm_revoke_team_member").handler({ user_id: MEMBRO }, ctx)) as { revoked_at?: string };
      expect(r.revoked_at).toBeTruthy();
      expect(escritas.find((e) => e.tabela === "user_organizations")?.filtros).toMatchObject({
        id: "vinculo-1",
        organization_id: ORG,
      });
      expect(escritas.find((e) => e.tabela === "api_tokens")?.filtros).toMatchObject({
        organization_id: ORG,
        created_by: MEMBRO,
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "member.revoked", actorApiTokenId: TOKEN, organizationId: ORG }),
      );

      const outro = ctxComBanco({ api_tokens: { created_by: DONO } });
      await expect(tool("crm_revoke_team_member").handler({ user_id: MEMBRO }, outro.ctx)).rejects.toMatchObject({
        status: 404,
      });
      expect(outro.escritas).toEqual([]);
    });

    it("crm_reactivate_team_member: devolve o acesso só de quem está revogado; já ativo é no-op sem escrita", async () => {
      const revogado = ctxComBanco({ api_tokens: { created_by: DONO }, user_organizations: { ...linhaDoMembro, revoked_at: "2026-10-01T00:00:00Z" } });
      const r = (await tool("crm_reactivate_team_member").handler({ user_id: MEMBRO }, revogado.ctx)) as {
        reactivated_at?: string;
      };
      expect(r.reactivated_at).toBeTruthy();
      expect(revogado.escritas.find((e) => e.op === "update")?.filtros).toMatchObject({ organization_id: ORG });

      const ativo = ctxComBanco({ api_tokens: { created_by: DONO }, user_organizations: linhaDoMembro });
      expect(await tool("crm_reactivate_team_member").handler({ user_id: MEMBRO }, ativo.ctx)).toMatchObject({
        already_active: true,
      });
      expect(ativo.escritas).toEqual([]);
    });
  });

  describe("funis", () => {
    const FUNIL_A = "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1";
    const FUNIL_B = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2";
    const funil = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      id,
      name,
      slug: name.toLowerCase(),
      description: null,
      position: 1000,
      is_default: false,
      is_client_pipeline: false,
      is_archived: false,
      ...extra,
    });

    it("crm_create_pipeline: grava na organização da chave com as etapas iniciais; nome repetido → 422 sem escrita", async () => {
      const { ctx, escritas } = ctxComBanco({ crm_pipelines: [funil(FUNIL_A, "Vendas", { is_default: true })] });
      await tool("crm_create_pipeline").handler({ name: "Pós-venda" }, ctx);
      expect(escritas.find((e) => e.tabela === "crm_pipelines" && e.op === "insert")?.patch).toMatchObject({
        organization_id: ORG,
        name: "Pós-venda",
        is_default: false,
      });
      expect(JSON.stringify(escritas.find((e) => e.tabela === "crm_stages" && e.op === "insert")?.patch)).toContain(ORG);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "pipeline.created", actorApiTokenId: TOKEN, organizationId: ORG }),
      );

      const repetido = ctxComBanco({ crm_pipelines: [funil(FUNIL_A, "Vendas", { is_default: true })] });
      await expect(tool("crm_create_pipeline").handler({ name: "vendas" }, repetido.ctx)).rejects.toMatchObject({
        status: 422,
      });
      expect(repetido.escritas).toEqual([]);
    });

    it("crm_update_pipeline: renomeia só na organização; funil de outra organização → 404; padrão=false → 422; sem campos → 422", async () => {
      const { ctx, escritas } = ctxComBanco({ crm_pipelines: [funil(FUNIL_A, "Vendas", { is_default: true })] });
      await tool("crm_update_pipeline").handler({ pipeline_id: FUNIL_A, name: "Comercial" }, ctx);
      const upd = escritas.find((e) => e.op === "update");
      expect(upd?.patch).toMatchObject({ name: "Comercial" });
      expect(upd?.filtros).toMatchObject({ id: FUNIL_A, organization_id: ORG });

      await expect(
        tool("crm_update_pipeline").handler({ pipeline_id: FUNIL_A, is_default: false }, ctx),
      ).rejects.toMatchObject({ status: 422 });
      await expect(tool("crm_update_pipeline").handler({ pipeline_id: FUNIL_A }, ctx)).rejects.toMatchObject({ status: 422 });
      await expect(
        tool("crm_update_pipeline").handler({ pipeline_id: FUNIL_B, name: "X" }, ctx),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("crm_delete_pipeline: arquiva por padrão (com org no filtro); o padrão não se arquiva; funil alheio → 404 sem escrita", async () => {
      const { ctx, escritas } = ctxComBanco({
        crm_pipelines: [funil(FUNIL_A, "Vendas", { is_default: true }), funil(FUNIL_B, "Pós")],
        crm_leads: [],
        webhook_sources: [],
        automation_rules: [],
      });
      await tool("crm_delete_pipeline").handler({ pipeline_id: FUNIL_B }, ctx);
      const arq = escritas.find((e) => e.op === "update");
      expect(arq?.patch).toMatchObject({ is_archived: true });
      expect(arq?.filtros).toMatchObject({ id: FUNIL_B, organization_id: ORG });

      await expect(tool("crm_delete_pipeline").handler({ pipeline_id: FUNIL_A }, ctx)).rejects.toMatchObject({ status: 422 });
      const alheio = ctxComBanco({ crm_pipelines: [funil(FUNIL_A, "Vendas", { is_default: true })] });
      await expect(
        tool("crm_delete_pipeline").handler({ pipeline_id: FUNIL_B }, alheio.ctx),
      ).rejects.toMatchObject({ status: 404 });
      expect(alheio.escritas).toEqual([]);
    });
  });

  describe("leituras de conexões e credenciais", () => {
    it("crm_list_channel_sessions: lista a organização da chave, sem coluna de segredo", async () => {
      const { ctx } = ctxComBanco({
        channel_sessions: [{ id: "c1", provider: "waha", display_name: "Comercial", status: "WORKING" }],
      });
      const r = (await tool("crm_list_channel_sessions").handler({}, ctx)) as { conexoes: unknown[] };
      expect(r.conexoes).toHaveLength(1);
    });

    it("crm_list_ai_credentials: a chave NÃO recebe os 4 últimos da chave de IA nem o autor", async () => {
      const { ctx } = ctxComBanco({
        ai_provider_credentials_safe: [
          { id: "k1", provider: "openai", label: "Principal", api_key_last4: "9f3a", created_by: DONO, is_active: true },
        ],
      });
      const r = (await tool("crm_list_ai_credentials").handler({}, ctx)) as { credenciais: Array<Record<string, unknown>> };
      expect(r.credenciais[0]).toMatchObject({ id: "k1", provider: "openai" });
      expect(JSON.stringify(r)).not.toContain("9f3a");
      expect(JSON.stringify(r)).not.toContain("api_key_last4");
      expect(JSON.stringify(r)).not.toContain("created_by");
    });
  });
});
