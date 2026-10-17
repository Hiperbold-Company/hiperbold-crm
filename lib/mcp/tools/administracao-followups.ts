/**
 * Capacidades de ADMINISTRAR os fluxos de follow-up por chave de API — fase 3 da API (17/10/2026):
 * listar, ler, criar, editar o rascunho, apagar, duplicar, publicar, desativar e reverter.
 *
 * ⚠️ AQUI HÁ TRADUÇÃO DE ARGUMENTO E NADA MAIS. A regra vive em `lib/followup/administracao.ts`, o MESMO
 * núcleo das rotas `/api/v1/ai/followup-flows/**` — a validação (Zod do grafo e do gatilho, validação de
 * publicação) roda lá, com o schema da tela.
 *
 * ⚠️ O PAPEL É O DA TELA: `viewer` para ler, `manager` para escrever. Todas `apenasHumano` no catálogo.
 * PUBLICAR arma o gatilho: o motor passa a mandar mensagens a clientes de verdade.
 */
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import {
  alterarFluxo,
  apagarFluxo,
  criarFluxo,
  desativarFluxo,
  duplicarFluxo,
  lerFluxo,
  listarFluxos,
  publicarFluxo,
  reverterFluxo,
  type DepsDeFollowup,
} from "@/lib/followup/administracao";
import { createFollowupFlowSchema, patchFollowupFlowSchema } from "@/lib/followup/api-schemas";

import type { McpContext, McpToolDefinition } from "../types";
import { responsavelDaChave } from "./administracao-fase3";

function depsDoFluxo(ctx: McpContext, responsavel: string | null = null): DepsDeFollowup {
  return {
    supabase: ctx.supabase,
    admin: ctx.supabase,
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    responsavel,
    requestId: ctx.requestId,
  };
}

function recusa(ctx: McpContext, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, ctx.requestId, message);
}

const listFlowsShape = { surface: z.enum(["followup", "atendimento"]).optional() };

export const crmListFollowupFlows: McpToolDefinition<typeof listFlowsShape> = {
  name: "crm_list_followup_flows",
  description:
    "Lista os fluxos de follow-up da empresa (nome, status draft/active/disabled, versão no ar, política de " +
    "handoff). surface='atendimento' lista os roteiros de atendimento em vez dos fluxos de follow-up.",
  inputSchema: listFlowsShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => ({
    fluxos: await listarFluxos(depsDoFluxo(ctx), {
      surface: input.surface === "atendimento" ? "atendimento" : undefined,
    }),
  }),
};

const flowIdShape = { flow_id: z.string().uuid() };

export const crmGetFollowupFlow: McpToolDefinition<typeof flowIdShape> = {
  name: "crm_get_followup_flow",
  description:
    "Devolve um fluxo de follow-up completo: rascunho do grafo (draft_graph), gatilho (trigger_config), política " +
    "de handoff, status, versão no ar e quantas versões existem (versions_count, previous_version_id).",
  inputSchema: flowIdShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => lerFluxo(depsDoFluxo(ctx), input.flow_id),
};

const createFlowShape = {
  name: z.string().min(1).max(80),
  surface: z.enum(["followup", "crm_automation", "atendimento"]).optional(),
};

export const crmCreateFollowupFlow: McpToolDefinition<typeof createFlowShape> = {
  name: "crm_create_followup_flow",
  description:
    "Cria um fluxo de follow-up VAZIO em rascunho (gatilho manual, sem grafo). Não envia nada: monte o grafo com " +
    "crm_update_followup_flow e só depois publique. Nome repetido é recusado. Exige papel manager.",
  inputSchema: createFlowShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const parsed = createFollowupFlowSchema.safeParse(input);
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Informe um nome de 1 a 80 caracteres.");
    return criarFluxo(depsDoFluxo(ctx), parsed.data);
  },
};

const updateFlowShape = {
  flow_id: z.string().uuid(),
  name: z.string().min(1).max(80).optional(),
  handoff_policy: z.enum(["pause", "cancel", "allow"]).optional(),
  /** Gatilho (`kind` + `params`), validado pelo MESMO schema da tela. */
  trigger_config: z.record(z.string(), z.unknown()).optional(),
  /** Grafo do rascunho (`nodes` + `edges`), validado pelo MESMO schema da tela; a semântica roda ao publicar. */
  draft_graph: z.record(z.string(), z.unknown()).optional(),
};

export const crmUpdateFollowupFlow: McpToolDefinition<typeof updateFlowShape> = {
  name: "crm_update_followup_flow",
  description:
    "Edita o RASCUNHO de um fluxo de follow-up: nome, política de handoff, gatilho (trigger_config) e/ou grafo " +
    "(draft_graph). Campo ausente não muda. Não publica: o que está no ar só muda em crm_publish_followup_flow. " +
    "Leia antes com crm_get_followup_flow para não sobrescrever o grafo. Exige papel manager.",
  inputSchema: updateFlowShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { flow_id, ...campos } = input;
    const parsed = patchFollowupFlowSchema.safeParse(
      Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined)),
    );
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Não entendi o que mudar no fluxo.");
    return alterarFluxo(depsDoFluxo(ctx), flow_id, parsed.data);
  },
};

export const crmDeleteFollowupFlow: McpToolDefinition<typeof flowIdShape> = {
  name: "crm_delete_followup_flow",
  description:
    "Apaga um fluxo de follow-up, as versões dele e TODAS as inscrições em andamento (os contatos deixam de " +
    "receber as mensagens que faltavam). Não dá para desfazer. Para só parar, use crm_disable_followup_flow. " +
    "Exige papel manager.",
  inputSchema: flowIdShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => ({ ...(await apagarFluxo(depsDoFluxo(ctx), input.flow_id)), deleted: true }),
};

export const crmDuplicateFollowupFlow: McpToolDefinition<typeof flowIdShape> = {
  name: "crm_duplicate_followup_flow",
  description:
    "Duplica um fluxo de follow-up como RASCUNHO com o sufixo ' (cópia)': copia grafo, gatilho e política de " +
    "handoff; não publica nem passa a enviar mensagem. Exige papel manager.",
  inputSchema: flowIdShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => duplicarFluxo(depsDoFluxo(ctx), input.flow_id),
};

export const crmPublishFollowupFlow: McpToolDefinition<typeof flowIdShape> = {
  name: "crm_publish_followup_flow",
  description:
    "PUBLICA o rascunho de um fluxo de follow-up: valida o grafo e o gatilho e, se estiver correto, coloca no ar. " +
    "A partir daí o motor matricula contatos e manda as mensagens do fluxo a clientes de verdade. Reprovado, " +
    "devolve 422 com a lista de erros por nó. Exige papel manager.",
  inputSchema: flowIdShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => publicarFluxo(depsDoFluxo(ctx, await responsavelDaChave(ctx)), input.flow_id),
};

export const crmDisableFollowupFlow: McpToolDefinition<typeof flowIdShape> = {
  name: "crm_disable_followup_flow",
  description:
    "Desativa um fluxo de follow-up: ele para de matricular contatos novos. Já desativado é no-op. Exige papel manager.",
  inputSchema: flowIdShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => desativarFluxo(depsDoFluxo(ctx), input.flow_id),
};

const rollbackFlowShape = { flow_id: z.string().uuid(), version_id: z.string().uuid() };

export const crmRollbackFollowupFlow: McpToolDefinition<typeof rollbackFlowShape> = {
  name: "crm_rollback_followup_flow",
  description:
    "Volta um fluxo de follow-up para uma versão anterior DELE (version_id de crm_get_followup_flow). Não cria " +
    "versão e não reativa um fluxo desativado. Exige papel manager.",
  inputSchema: rollbackFlowShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => reverterFluxo(depsDoFluxo(ctx), input.flow_id, input.version_id),
};
