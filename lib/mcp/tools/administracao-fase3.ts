/**
 * Capacidades de ADMINISTRAR a operação por chave de API — fase 3 da API (17/10/2026): respostas
 * prontas, follow-ups, roteadores, regras automáticas, roteamento de atendimento, material de
 * conhecimento e equipe/funis (tools sobre rotas que já tinham Bearer).
 *
 * ⚠️ AQUI HÁ TRADUÇÃO DE ARGUMENTO E NADA MAIS. A regra vive nos MESMOS núcleos das rotas REST
 * (`lib/operacao/respostas-prontas.ts` etc.), com os schemas da tela.
 *
 * ⚠️ O PAPEL É O DA ROTA/TELA EQUIVALENTE. Todas `apenasHumano` no catálogo — o agente publicado
 * nunca administra a empresa em que atende. A organização sai SEMPRE de `ctx.organizationId`.
 * Não há segundo fator para chave: o limite de confiança é a emissão da chave
 * (ver `lib/api/auth-dual-admin.ts`).
 */
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import {
  alterarRespostaPronta,
  apagarRespostaPronta,
  criarRespostaPronta,
} from "@/lib/operacao/respostas-prontas";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import { createTemplateSchema, updateTemplateSchema } from "@/lib/schemas/templates";

import type { McpContext, McpToolDefinition } from "../types";

function deps(ctx: McpContext): DepsDaOperacao {
  return {
    supabase: ctx.supabase,
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    requestId: ctx.requestId,
  };
}

function recusa(ctx: McpContext, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, ctx.requestId, message);
}

/**
 * A PESSOA que emitiu a chave (`api_tokens.created_by`, lida da MESMA organização). Colunas com FK em
 * `auth.users` (`created_by_user_id`) nunca recebem o id do token.
 */
export async function responsavelDaChave(ctx: McpContext): Promise<string> {
  const { data } = await ctx.supabase
    .from("api_tokens")
    .select("created_by")
    .eq("id", ctx.apiTokenId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  const pessoa = (data as { created_by?: string | null } | null)?.created_by ?? null;
  if (!pessoa) throw recusa(ctx, 403, "forbidden", "Não foi possível identificar quem responde por esta chave.");
  return pessoa;
}

// ---------------------------------------------------------------------------
// respostas prontas (message_templates)
// ---------------------------------------------------------------------------

const createTemplateShape = {
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(4096),
  shortcut: z.string().min(1).max(40).optional(),
};

export const crmCreateMessageTemplate: McpToolDefinition<typeof createTemplateShape> = {
  name: "crm_create_message_template",
  description:
    "Cria uma resposta pronta COMPARTILHADA da empresa (título, corpo com marcações {{...}} e atalho opcional). " +
    "Uma chave de API não tem resposta pessoal. A equipe passa a vê-la na hora, no atalho da conversa. " +
    "Exige papel manager.",
  inputSchema: createTemplateShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const parsed = createTemplateSchema.safeParse({ ...input, shared: true });
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Dados inválidos para a resposta pronta.");
    return criarRespostaPronta(deps(ctx), parsed.data, await responsavelDaChave(ctx));
  },
};

const updateTemplateShape = {
  template_id: z.string().uuid(),
  title: z.string().min(1).max(80).optional(),
  body: z.string().min(1).max(4096).optional(),
  /** `null` remove o atalho. */
  shortcut: z.string().min(1).max(40).nullable().optional(),
};

export const crmUpdateMessageTemplate: McpToolDefinition<typeof updateTemplateShape> = {
  name: "crm_update_message_template",
  description:
    "Altera título, corpo e/ou atalho de uma resposta pronta COMPARTILHADA (shortcut=null remove o atalho). " +
    "A resposta pessoal de um atendente não é alcançável por chave. Exige papel manager.",
  inputSchema: updateTemplateShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { template_id, ...alteracao } = input;
    const parsed = updateTemplateSchema.safeParse(
      Object.fromEntries(Object.entries(alteracao).filter(([, v]) => v !== undefined)),
    );
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Diga o que mudar na resposta pronta.");
    return alterarRespostaPronta(deps(ctx), template_id, parsed.data);
  },
};

const deleteTemplateShape = { template_id: z.string().uuid() };

export const crmDeleteMessageTemplate: McpToolDefinition<typeof deleteTemplateShape> = {
  name: "crm_delete_message_template",
  description:
    "Apaga uma resposta pronta COMPARTILHADA da empresa. A equipe deixa de vê-la na hora; mensagens já " +
    "enviadas com ela não mudam. Exige papel manager.",
  inputSchema: deleteTemplateShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => ({ ...(await apagarRespostaPronta(deps(ctx), input.template_id)), deleted: true }),
};
