/**
 * Capacidades de ADMINISTRAR a distribuição de atendimento por chave de API — fase 3 da API (17/10/2026):
 * ler e alterar o roteamento das conversas e a visibilidade de cada atendente.
 *
 * ⚠️ AQUI HÁ TRADUÇÃO DE ARGUMENTO E NADA MAIS. A regra vive em `lib/organizacao/atendimento.ts`, o MESMO
 * núcleo da rota `/api/v1/settings/routing`, com o schema da tela.
 *
 * ⚠️ O PAPEL É O DA TELA (`manager`). Ambas `apenasHumano`. `visibility_mode` decide quem enxerga cada
 * negócio e conversa: restringi-lo esconde da equipe o que não é dela.
 */
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { gravarAtendimento, lerAtendimento, type DepsDeAtendimento } from "@/lib/organizacao/atendimento";
import { atendimentoConfigPatchSchema, VISIBILITY_MODES } from "@/lib/schemas/routing";

import type { McpContext, McpToolDefinition } from "../types";

function depsDoAtendimento(ctx: McpContext): DepsDeAtendimento {
  return {
    supabase: ctx.supabase,
    admin: ctx.supabase,
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    requestId: ctx.requestId,
  };
}

const getShape = {};

export const crmGetAttendanceRouting: McpToolDefinition<typeof getShape> = {
  name: "crm_get_attendance_routing",
  description:
    "Devolve como as conversas são distribuídas (mode manual ou round_robin, tentativas e espera), o prazo para devolver " +
    "ao agente de IA uma conversa parada com uma pessoa (handoff_return_after_minutes), se a conversa fica com quem " +
    "atendeu e a visibilidade da equipe (visibility_mode: all, own_and_unassigned ou own).",
  inputSchema: getShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => lerAtendimento(depsDoAtendimento(ctx)),
};

const updateShape = {
  mode: z.enum(["manual", "round_robin"]).optional(),
  max_retries: z.number().int().min(0).max(20).optional(),
  backoff_seconds: z.number().int().min(1).max(3600).optional(),
  /** `null` = nunca devolver sozinho (regra de sempre). */
  handoff_return_after_minutes: z.number().int().nullable().optional(),
  conversation_stays_with_attendant: z.boolean().optional(),
  visibility_mode: z.enum(VISIBILITY_MODES).optional(),
};

export const crmUpdateAttendanceRouting: McpToolDefinition<typeof updateShape> = {
  name: "crm_update_attendance_routing",
  description:
    "Altera a distribuição de atendimento: mode, max_retries, backoff_seconds, handoff_return_after_minutes, " +
    "conversation_stays_with_attendant e/ou visibility_mode. Campo ausente mantém o valor em vigor. round_robin passa a " +
    "repartir conversas novas entre a equipe; visibility_mode='own' esconde dos atendentes tudo o que não é deles, na hora. " +
    "Exige papel manager.",
  inputSchema: updateShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const pedidos = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (Object.keys(pedidos).length === 0) {
      throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Diga o que mudar na distribuição de atendimento.");
    }
    const deps = depsDoAtendimento(ctx);
    // O PATCH da tela troca o bloco inteiro de `routing`; aqui o que não veio mantém o valor em vigor.
    const atual = await lerAtendimento(deps);
    const { visibility_mode: _visibilidadeAtual, ...routingAtual } = atual;
    void _visibilidadeAtual;
    const parsed = atendimentoConfigPatchSchema.safeParse({ ...routingAtual, ...pedidos });
    if (!parsed.success) {
      throw new ApiError(422, "unprocessable_entity", undefined, ctx.requestId, "Não entendi o que mudar na distribuição.");
    }
    return gravarAtendimento(deps, parsed.data);
  },
};
