/**
 * Capacidades de ADMINISTRAR as regras automáticas por chave de API — fase 3 da API (17/10/2026): criar,
 * editar e apagar. (Listar e ligar/desligar já existiam: `crm_list_automation_rules`,
 * `crm_set_automation_rule_active`.)
 *
 * ⚠️ AQUI HÁ TRADUÇÃO DE ARGUMENTO E NADA MAIS. A regra vive em `lib/operacao/regras-automaticas-admin.ts`, o
 * MESMO núcleo das rotas `/api/v1/automation-rules/**`, com o schema da tela.
 *
 * ⚠️ O PAPEL É O DA TELA (`manager`). Todas `apenasHumano`: deixar o agente ESCREVER a ação seria deixá-lo
 * escolher para qual endereço externo a empresa manda dados. A regra nasce PAUSADA; ligar é
 * `crm_set_automation_rule_active` (ou `is_active` na edição).
 *
 * ⚠️ `actions` carrega o segredo de `call_webhook` em texto quando quem chama o digita: ele NUNCA entra no
 * audit (`redigirParaAuditoria`) e nunca volta na resposta.
 */
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import {
  alterarRegra,
  apagarRegra,
  criarRegra,
  type DepsDeRegras,
} from "@/lib/operacao/regras-automaticas-admin";
import { createAutomationRuleSchema, updateAutomationRuleSchema } from "@/lib/schemas";

import type { McpContext, McpToolDefinition } from "../types";
import { responsavelDaChave } from "./administracao-fase3";

function depsDaRegra(ctx: McpContext, responsavel: string | null = null): DepsDeRegras {
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

/** As ações podem carregar o segredo do webhook em texto: o audit guarda quantas, nunca o conteúdo. */
function semAcoesNoAudit(args: Record<string, unknown>): Record<string, unknown> {
  if (!("actions" in args)) return args;
  const n = Array.isArray(args.actions) ? args.actions.length : 0;
  return { ...args, actions: `[redacted:${n}]` };
}

const livre = z.record(z.string(), z.unknown());

const createShape = {
  name: z.string().min(1).max(120),
  trigger_event: z.string().min(1).max(80),
  conditions: z.array(livre).max(10).optional(),
  /** `[{ type, config }]`. Para `call_webhook`, `config.secret` (texto) é cifrado e nunca volta. */
  actions: z.array(livre).min(1).max(10),
  trigger_config: livre.optional(),
};

export const crmCreateAutomationRule: McpToolDefinition<typeof createShape> = {
  name: "crm_create_automation_rule",
  description:
    "Cria uma regra automática (gatilho + condições + ações). Ela nasce PAUSADA: só passa a disparar quando for " +
    "ligada (crm_set_automation_rule_active). Ação call_webhook manda dados da empresa para fora e send_whatsapp_message " +
    "fala com clientes — confira a regra com quem pediu antes de ligar. O segredo digitado em config.secret é cifrado e " +
    "nunca volta. Validado pelo mesmo schema da tela. Exige papel manager.",
  inputSchema: createShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  redigirParaAuditoria: semAcoesNoAudit,
  handler: async (input, ctx) => {
    const parsed = createAutomationRuleSchema.safeParse(input);
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Não entendi a regra: confira gatilho, condições e ações.");
    return criarRegra(depsDaRegra(ctx, await responsavelDaChave(ctx)), parsed.data);
  },
};

const updateShape = {
  rule_id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  trigger_event: z.string().min(1).max(80).optional(),
  conditions: z.array(livre).max(10).optional(),
  /** SUBSTITUI a lista inteira de ações (config.secret em texto é cifrado de novo; o antigo não volta). */
  actions: z.array(livre).min(1).max(10).optional(),
  trigger_config: livre.optional(),
  /** Ligar uma regra a faz disparar em todo evento que casar, sozinha. */
  is_active: z.boolean().optional(),
};

export const crmUpdateAutomationRule: McpToolDefinition<typeof updateShape> = {
  name: "crm_update_automation_rule",
  description:
    "Edita uma regra automática: nome, gatilho, condições, ações (SUBSTITUI a lista) e/ou is_active. Campo ausente não " +
    "muda. Ligar (is_active=true) faz a regra disparar sozinha em todo evento que casar; mudar ações de uma regra " +
    "ligada muda o que ela faz agora. Validado pelo mesmo schema da tela. Exige papel manager.",
  inputSchema: updateShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  redigirParaAuditoria: semAcoesNoAudit,
  handler: async (input, ctx) => {
    const { rule_id, ...campos } = input;
    const parsed = updateAutomationRuleSchema.safeParse(
      Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined)),
    );
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Não entendi o que mudar na regra.");
    return alterarRegra(depsDaRegra(ctx), rule_id, parsed.data);
  },
};

const deleteShape = { rule_id: z.string().uuid() };

export const crmDeleteAutomationRule: McpToolDefinition<typeof deleteShape> = {
  name: "crm_delete_automation_rule",
  description:
    "Apaga uma regra automática e o que ela fazia sozinha. O histórico de execuções já gravado permanece. Para só " +
    "parar, use crm_set_automation_rule_active. Exige papel manager.",
  inputSchema: deleteShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => ({ ...(await apagarRegra(depsDaRegra(ctx), input.rule_id)), deleted: true }),
};
