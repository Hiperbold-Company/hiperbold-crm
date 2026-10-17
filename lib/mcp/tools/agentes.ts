/**
 * Capacidades de ADMINISTRAR os agentes de IA por chave de API — fase 2 da API (17/10/2026):
 * listar, ler, criar rascunho, salvar versão nova, publicar e pausar.
 *
 * ⚠️ AQUI HÁ TRADUÇÃO DE ARGUMENTO E NADA MAIS. A regra vive em `lib/ai/agents/administracao.ts`, o
 * MESMO núcleo das rotas `/api/v1/ai/agents/**` — a validação (Zod da versão, escopo, credencial,
 * capacidades) roda lá, com o schema da tela.
 *
 * ⚠️ O PAPEL É O DA TELA: `manager` para ler, `admin` para escrever. Todas `apenasHumano` no
 * catálogo — o agente publicado nunca edita nem publica agente. A organização sai SEMPRE de
 * `ctx.organizationId`. PUBLICAR coloca o agente para responder clientes de verdade.
 */
import { z } from "zod";

import {
  criarAgenteMcp,
  criarVersaoDoAgente,
  lerAgenteComVersoes,
  listarAgentes,
  pausarAgente,
  publicarVersaoDoAgente,
  type DepsDeAgentes,
} from "@/lib/ai/agents/administracao";
import { ApiError } from "@/lib/api/types";

import type { McpContext, McpToolDefinition } from "../types";

/** `created_by` tem FK em auth.users: a pessoa que emitiu a chave (lida da linha do token, da MESMA organização). */
async function dependencias(ctx: McpContext, comResponsavel: boolean): Promise<DepsDeAgentes> {
  let responsavel: string | null = null;
  if (comResponsavel) {
    const { data } = await ctx.supabase
      .from("api_tokens")
      .select("created_by")
      .eq("id", ctx.apiTokenId)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    responsavel = (data as { created_by?: string | null } | null)?.created_by ?? null;
    if (!responsavel) {
      throw new ApiError(403, "forbidden", undefined, ctx.requestId, "Não foi possível identificar quem responde por esta chave.");
    }
  }
  return {
    supabase: ctx.supabase,
    admin: ctx.supabase,
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    responsavel,
    requestId: ctx.requestId,
  };
}

const listShape = { include_archived: z.boolean().optional() };

export const crmListAiAgents: McpToolDefinition<typeof listShape> = {
  name: "crm_list_ai_agents",
  description:
    "Lista os agentes de IA da empresa (nome, tipo, prioridade, se está publicado ou pausado, e o modelo da versão " +
    "publicada). Agentes arquivados só aparecem com include_archived=true.",
  inputSchema: listShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => ({
    agents: await listarAgentes(await dependencias(ctx, false), { incluirArquivados: input.include_archived === true }),
  }),
};

const getShape = { agent_id: z.string().uuid() };

export const crmGetAiAgent: McpToolDefinition<typeof getShape> = {
  name: "crm_get_ai_agent",
  description:
    "Devolve um agente de IA e todas as versões dele (da mais nova para a mais velha), com o prompt, as capacidades " +
    "(tool_ids), o escopo (funis e materiais) e o status de cada versão: draft, published ou superseded.",
  inputSchema: getShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => lerAgenteComVersoes(await dependencias(ctx, false), input.agent_id),
};

const versaoLivre = z
  .record(z.string(), z.unknown())
  .describe(
    "Conteúdo da versão: system_prompt, provider, model, credential_id (null = chave da instalação), tool_ids, " +
      "pipeline_ids, knowledge_source_ids, channel_session_id, max_steps, token_budget, cost_budget_cents, " +
      "history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, cases_enabled, " +
      "split_messages, split_max_chars, followup, operator_*. Validado pelo MESMO schema da tela.",
  );

const createShape = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  version: versaoLivre,
};

export const crmCreateAiAgent: McpToolDefinition<typeof createShape> = {
  name: "crm_create_ai_agent",
  description:
    "Cria um agente de IA com a versão 1 em RASCUNHO. NÃO publica: o agente só atende clientes depois de " +
    "crm_publish_ai_agent_version. funis, materiais e capacidades da version precisam existir nesta empresa. Exige papel admin.",
  inputSchema: createShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => criarAgenteMcp(await dependencias(ctx, true), input),
};

const createVersionShape = { agent_id: z.string().uuid(), version: versaoLivre };

export const crmCreateAiAgentVersion: McpToolDefinition<typeof createVersionShape> = {
  name: "crm_create_ai_agent_version",
  description:
    "Salva uma versão NOVA em rascunho para um agente (o conteúdo inteiro da versão, como o botão Salvar da tela). A " +
    "versão publicada não muda até crm_publish_ai_agent_version. Exige papel admin.",
  inputSchema: createVersionShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => criarVersaoDoAgente(await dependencias(ctx, true), input.agent_id, input.version),
};

const publishShape = { agent_id: z.string().uuid(), version_id: z.string().uuid() };

export const crmPublishAiAgentVersion: McpToolDefinition<typeof publishShape> = {
  name: "crm_publish_ai_agent_version",
  description:
    "PUBLICA uma versão de agente: a partir daí o agente responde clientes de verdade com ela (a versão anterior vira " +
    "superseded). Valida credencial, canal, modelo e capacidades antes e devolve o motivo estável da recusa. " +
    "Confirme com um humano antes de publicar. Exige papel admin.",
  inputSchema: publishShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => publicarVersaoDoAgente(await dependencias(ctx, false), input.agent_id, input.version_id),
};

const pauseShape = { agent_id: z.string().uuid() };

export const crmPauseAiAgent: McpToolDefinition<typeof pauseShape> = {
  name: "crm_pause_ai_agent",
  description:
    "Pausa um agente de IA: ele para de responder clientes imediatamente e a conversa fica com a equipe. A pausa é " +
    "desfeita pela tela do agente (ou PATCH /api/v1/ai/agents/{id} com paused_at null). Exige papel admin.",
  inputSchema: pauseShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => pausarAgente(await dependencias(ctx, false), input.agent_id),
};
