/**
 * Capacidades de ADMINISTRAR os roteadores de intenção por chave de API — fase 3 da API (17/10/2026):
 * listar, ler, criar, editar, apagar e definir os membros.
 *
 * ⚠️ AQUI HÁ TRADUÇÃO DE ARGUMENTO E NADA MAIS. A regra vive em `lib/ai/agents/roteadores.ts`, o MESMO núcleo
 * das rotas `/api/v1/ai/routers/**`, com os schemas da tela.
 *
 * ⚠️ O PAPEL É O DA TELA: `agent` para ler, `admin` para escrever. Todas `apenasHumano` no catálogo. O
 * roteador decide para QUAL agente cada conversa vai: mexer nele muda quem atende o cliente.
 */
import { z } from "zod";

import {
  alterarRoteador,
  alterarRoteadorSchema,
  apagarRoteador,
  criarRoteador,
  criarRoteadorSchema,
  definirMembrosDoRoteador,
  lerRoteador,
  listarRoteadores,
  membrosDoRoteadorSchema,
  type DepsDeRoteadores,
} from "@/lib/ai/agents/roteadores";
import { ApiError } from "@/lib/api/types";

import type { McpContext, McpToolDefinition } from "../types";
import { responsavelDaChave } from "./administracao-fase3";

function depsDoRoteador(ctx: McpContext, responsavel: string | null = null): DepsDeRoteadores {
  return {
    admin: () => ctx.supabase,
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    responsavel,
    requestId: ctx.requestId,
  };
}

function recusa(ctx: McpContext, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, ctx.requestId, message);
}

const listShape = {};

export const crmListAiRouters: McpToolDefinition<typeof listShape> = {
  name: "crm_list_ai_routers",
  description:
    "Lista os roteadores de intenção da empresa (nome, número de WhatsApp, se está ativo, agente de reserva e " +
    "quantas intenções tem). Cada número tem no máximo um roteador ativo.",
  inputSchema: listShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => listarRoteadores(depsDoRoteador(ctx)),
};

const idShape = { router_id: z.string().uuid() };

export const crmGetAiRouter: McpToolDefinition<typeof idShape> = {
  name: "crm_get_ai_router",
  description:
    "Devolve um roteador de intenção e as intenções dele (agente, nome, descrição, exemplos, ordem e fluxo de " +
    "atendimento vinculado).",
  inputSchema: idShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => lerRoteador(depsDoRoteador(ctx), input.router_id),
};

const createShape = {
  name: z.string().min(1).max(120),
  channel_session_id: z.string().uuid(),
  fallback_agent_id: z.string().uuid().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
};

export const crmCreateAiRouter: McpToolDefinition<typeof createShape> = {
  name: "crm_create_ai_router",
  description:
    "Cria um roteador de intenção para UM número de WhatsApp da empresa (channel_session_id). Nasce sem " +
    "intenções: defina-as com crm_set_ai_router_members. Número que já tem roteador ativo é recusado (409); " +
    "número ou agente de outra organização é recusado. Exige papel admin.",
  inputSchema: createShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const parsed = criarRoteadorSchema.safeParse(input);
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Dados inválidos para o roteador.");
    return criarRoteador(depsDoRoteador(ctx, await responsavelDaChave(ctx)), parsed.data);
  },
};

const updateShape = {
  router_id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  is_active: z.boolean().optional(),
  fallback_agent_id: z.string().uuid().nullable().optional(),
  /** Mescla com a configuração atual (chave ausente não muda). */
  config: z.record(z.string(), z.unknown()).optional(),
};

export const crmUpdateAiRouter: McpToolDefinition<typeof updateShape> = {
  name: "crm_update_ai_router",
  description:
    "Edita um roteador de intenção: nome, is_active (liga/desliga — desligar faz as conversas daquele número " +
    "voltarem ao atendimento padrão), agente de reserva e config (mescla). Exige papel admin.",
  inputSchema: updateShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { router_id, ...campos } = input;
    const parsed = alterarRoteadorSchema.safeParse(
      Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined)),
    );
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Não entendi o que mudar no roteador.");
    return alterarRoteador(depsDoRoteador(ctx), router_id, parsed.data);
  },
};

export const crmDeleteAiRouter: McpToolDefinition<typeof idShape> = {
  name: "crm_delete_ai_router",
  description:
    "Apaga um roteador de intenção e as intenções dele. As conversas daquele número passam a ser atendidas sem " +
    "roteador. Para só pausar, use crm_update_ai_router com is_active=false. Exige papel admin.",
  inputSchema: idShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => ({ ...(await apagarRoteador(depsDoRoteador(ctx), input.router_id)), deleted: true }),
};

const membersShape = {
  router_id: z.string().uuid(),
  /** A lista INTEIRA: o que não estiver nela deixa de existir. A ordem do array é a prioridade. */
  members: z.array(
    z.object({
      agent_id: z.string().uuid(),
      intent_name: z.string().min(1).max(120),
      intent_description: z.string().min(1).max(2000),
      examples: z.array(z.string()).optional(),
      flow_pointer_id: z.string().uuid().nullable().optional(),
    }),
  ),
};

export const crmSetAiRouterMembers: McpToolDefinition<typeof membersShape> = {
  name: "crm_set_ai_router_members",
  description:
    "SUBSTITUI a lista inteira de intenções de um roteador (leia antes com crm_get_ai_router). Cada intenção liga " +
    "um nome e uma descrição a um agente da MESMA organização (e, opcionalmente, a um fluxo de atendimento). Nomes " +
    "repetidos são recusados. Muda na hora para qual agente cada conversa vai. Exige papel admin.",
  inputSchema: membersShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const parsed = membrosDoRoteadorSchema.safeParse({ members: input.members });
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Dados inválidos para as intenções.");
    return definirMembrosDoRoteador(depsDoRoteador(ctx), input.router_id, parsed.data.members);
  },
};
