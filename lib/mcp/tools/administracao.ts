/**
 * Capacidades de ADMINISTRAR a organização por chave de API — fase 1 da API
 * (17/10/2026): configuração do funil, entradas automáticas (editar/apagar) e
 * dados da empresa.
 *
 * ⚠️ AQUI HÁ TRADUÇÃO DE ARGUMENTO E NADA MAIS. A regra vive nos mesmos núcleos
 * das rotas REST e das telas (`lib/pipelines/configuracao-do-funil.ts`,
 * `lib/operacao/entradas-automaticas.ts`, `lib/organizacao/configuracao.ts`).
 *
 * ⚠️ O PAPEL É O DA ROTA/TELA EQUIVALENTE: `admin` para escrever configuração do
 * funil e dados da empresa (como as server actions), `manager` para entradas
 * automáticas (como a rota). Todas `apenasHumano` no catálogo — nunca ao alcance
 * do agente publicado — e a organização sai SEMPRE de `ctx.organizationId`.
 * Não há segundo fator para chave: o limite de confiança é a emissão da chave
 * (ver `lib/api/auth-dual-admin.ts`).
 */
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { interfaceSettingsSchema } from "@/lib/navigation/interface";
import {
  atualizarEntradaAutomatica,
  excluirEntradaAutomatica,
  type DepsDaOperacao,
} from "@/lib/operacao/entradas-automaticas";
import {
  atualizarDadosDaEmpresa,
  atualizarInterfaceDaOrganizacao,
  atualizarPerfilDaOrganizacao,
  lerConfiguracaoDaOrganizacao,
} from "@/lib/organizacao/configuracao";
import {
  aplicarConfiguracaoDoFunil,
  lerConfiguracaoDoFunil,
} from "@/lib/pipelines/configuracao-do-funil";
import { perfilDaEmpresaSchema } from "@/lib/schemas/perfil-da-empresa";
import { tenantSchema, type PipelineConfigPatch } from "@/lib/schemas/settings";
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

// ---------------------------------------------------------------------------
// configuração do funil
// ---------------------------------------------------------------------------

const getPipelineConfigShape = { pipeline_id: z.string().uuid() };

export const crmGetPipelineConfig: McpToolDefinition<typeof getPipelineConfigShape> = {
  name: "crm_get_pipeline_config",
  description:
    "Devolve a configuração de UM pipeline: vocabulário (lead/deal/won/lost), campos personalizados (fields), " +
    "motivos de perda (lost_reasons) e de ganho (won_reasons, won_reason_required) e a política de reabertura. " +
    "Use antes de crm_update_pipeline_config para não sobrescrever o que já existe.",
  inputSchema: getPipelineConfigShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const lida = await lerConfiguracaoDoFunil(ctx.supabase, ctx.organizationId, input.pipeline_id);
    if (!lida.ok) {
      if (lida.error === "not_found") throw recusa(ctx, 404, "not_found", "Funil não encontrado.");
      throw recusa(ctx, 500, "internal_error", lida.error);
    }
    return lida.dados;
  },
};

const updatePipelineConfigShape = {
  pipeline_id: z.string().uuid(),
  /**
   * O patch de `pipelineConfigPatchSchema` (`lib/schemas/settings.ts`). Chega como
   * objeto livre porque o schema tem transformações, que o JSON Schema do MCP não
   * representa; quem valida de verdade é `aplicarConfiguracaoDoFunil`, com o MESMO
   * schema da tela.
   */
  config: z.record(z.string(), z.unknown()),
};

export const crmUpdatePipelineConfig: McpToolDefinition<typeof updatePipelineConfigShape> = {
  name: "crm_update_pipeline_config",
  description:
    "Grava a configuração de um pipeline. `config` aceita: vocabulary (merge por chave), fields (SUBSTITUI a lista " +
    "inteira de campos personalizados — leia antes com crm_get_pipeline_config), lost_reasons, won_reasons, " +
    "won_reason_required, reabertura e reabertura_campos. Chave ausente não muda. Exige papel admin.",
  inputSchema: updatePipelineConfigShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const r = await aplicarConfiguracaoDoFunil(ctx.supabase, {
      organizationId: ctx.organizationId,
      pipelineId: input.pipeline_id,
      patch: input.config as PipelineConfigPatch,
      autor: colunasDeAtorNoAudit(ctx.actor),
      requestId: ctx.requestId,
    });
    if (!r.ok) {
      if (r.error === "not_found") throw recusa(ctx, 404, "not_found", "Funil não encontrado.");
      if (r.error === "validation_failed") {
        throw recusa(ctx, 422, "unprocessable_entity", "Não entendi o que mudar na configuração deste funil.");
      }
      throw recusa(ctx, 500, "internal_error", r.error);
    }
    return r.dados;
  },
};

// ---------------------------------------------------------------------------
// entradas automáticas (webhook_sources)
// ---------------------------------------------------------------------------

const updateSourceShape = {
  source_id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  default_pipeline_id: z.string().uuid().optional(),
  default_stage_id: z.string().uuid().optional(),
  redirect_to: z.string().url().max(2000).nullable().optional(),
  field_map: z
    .object({
      name: z.array(z.string()).optional(),
      phone: z.array(z.string()).optional(),
      email: z.array(z.string()).optional(),
    })
    .optional(),
  is_active: z.boolean().optional(),
};

export const crmUpdateWebhookSource: McpToolDefinition<typeof updateSourceShape> = {
  name: "crm_update_webhook_source",
  description:
    "Edita uma entrada automática de contatos: nome, destino (pipeline + stage da MESMA organização, stage em uso), " +
    "redirect_to, field_map e is_active. O segredo de assinatura NÃO é editável por aqui (use a tela). " +
    "Mudar o destino ou desligar muda imediatamente para onde os contatos de fora vão.",
  inputSchema: updateSourceShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { source_id, ...edicao } = input;
    if (Object.keys(edicao).length === 0) {
      throw recusa(ctx, 422, "unprocessable_entity", "Diga o que mudar na entrada automática.");
    }
    return atualizarEntradaAutomatica(deps(ctx), source_id, edicao);
  },
};

const deleteSourceShape = { source_id: z.string().uuid() };

export const crmDeleteWebhookSource: McpToolDefinition<typeof deleteSourceShape> = {
  name: "crm_delete_webhook_source",
  description:
    "Apaga uma entrada automática de contatos. A URL de captação deixa de existir e o formulário que ainda a usa " +
    "para de virar contato — sem aviso do outro lado. Para só pausar, use crm_set_webhook_source_active.",
  inputSchema: deleteSourceShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    await excluirEntradaAutomatica(deps(ctx), input.source_id);
    return { id: input.source_id, deleted: true };
  },
};

// ---------------------------------------------------------------------------
// dados da organização
// ---------------------------------------------------------------------------

const getOrgShape = {};

export const crmGetOrganizationSettings: McpToolDefinition<typeof getOrgShape> = {
  name: "crm_get_organization_settings",
  description:
    "Devolve os dados da empresa (nome, razão social, país, fuso, idioma, moeda, retenção de mídia, DPO, política " +
    "de privacidade), o texto de 'o que a empresa faz' (o_que_faz) e as portas do menu (interface_settings).",
  inputSchema: getOrgShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const config = await lerConfiguracaoDaOrganizacao(ctx.supabase, ctx.organizationId);
    if (!config) throw recusa(ctx, 404, "not_found", "Organização não encontrada.");
    return config;
  },
};

// Formas simples (sem transformações — o JSON Schema do MCP não as representa); o
// conjunto final é validado pelo MESMO `tenantSchema` da tela, no handler.
const updateOrgShape = {
  display_name: z.string().min(1).max(120).optional(),
  legal_name: z.string().min(1).max(200).optional(),
  cnpj: z.string().max(20).nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  locale: z.string().optional(),
  currency: z.string().optional(),
  media_retention_days: z.number().int().min(30).max(3650).optional(),
  dpo_email: z.string().email().max(200).nullable().optional(),
  privacy_policy_url: z.string().url().max(2048).nullable().optional(),
  o_que_faz: z.string().min(2).max(280).optional(),
  interface_settings: z
    .object({
      preset: z.enum(["completa", "simplificada"]),
      destinos: z.array(z.string()).optional(),
    })
    .optional(),
};

export const crmUpdateOrganizationSettings: McpToolDefinition<typeof updateOrgShape> = {
  name: "crm_update_organization_settings",
  description:
    "Atualiza dados da empresa (display_name, legal_name, cnpj, country, timezone, locale, currency, " +
    "media_retention_days, dpo_email, privacy_policy_url), o texto o_que_faz e/ou interface_settings. " +
    "Campo ausente não muda. Exige papel admin; o país precisa ter perfil legal revisado.",
  inputSchema: updateOrgShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { interface_settings: interfaceBruta, ...semInterface } = input;
    const oQueFazValido = semInterface.o_que_faz === undefined ? undefined : perfilDaEmpresaSchema.safeParse({ o_que_faz: semInterface.o_que_faz });
    if (oQueFazValido && !oQueFazValido.success) {
      throw recusa(ctx, 422, "unprocessable_entity", "O texto sobre o que a empresa faz precisa ter de 2 a 280 caracteres.");
    }
    const interfaceValida = interfaceBruta === undefined ? undefined : interfaceSettingsSchema.safeParse(interfaceBruta);
    if (interfaceValida && !interfaceValida.success) {
      throw recusa(ctx, 422, "unprocessable_entity", "As áreas do menu escolhidas não são válidas.");
    }
    const interface_settings = interfaceValida?.success ? interfaceValida.data : undefined;
    const { o_que_faz: _ignorado, ...dadosPedidos } = semInterface;
    void _ignorado;
    const o_que_faz = oQueFazValido?.success ? oQueFazValido.data.o_que_faz : undefined;
    const pedidos = Object.fromEntries(Object.entries(dadosPedidos).filter(([, v]) => v !== undefined));
    if (Object.keys(pedidos).length === 0 && o_que_faz === undefined && interface_settings === undefined) {
      throw recusa(ctx, 422, "unprocessable_entity", "Diga o que mudar na organização.");
    }
    const autor = { ...colunasDeAtorNoAudit(ctx.actor), requestId: ctx.requestId };
    const falha = (r: { ok: boolean; error?: string }) => {
      if (r.ok) return;
      const e = r.error ?? "internal_error";
      const status = e === "sem_area" || e.startsWith("País sem perfil") ? 422 : 500;
      throw recusa(ctx, status, status === 422 ? "unprocessable_entity" : "internal_error", e);
    };

    if (Object.keys(pedidos).length > 0) {
      const atual = await lerConfiguracaoDaOrganizacao(ctx.supabase, ctx.organizationId);
      if (!atual) throw recusa(ctx, 404, "not_found", "Organização não encontrada.");
      const completo = tenantSchema.safeParse({
        display_name: atual.display_name,
        legal_name: atual.legal_name,
        cnpj: atual.cnpj,
        country: atual.country,
        timezone: atual.timezone,
        locale: atual.locale,
        currency: atual.currency,
        media_retention_days: atual.media_retention_days,
        dpo_email: atual.dpo_email,
        privacy_policy_url: atual.privacy_policy_url,
        ...pedidos,
      });
      if (!completo.success) {
        throw recusa(ctx, 422, "unprocessable_entity", "Não entendi o que mudar na organização.");
      }
      falha(await atualizarDadosDaEmpresa(ctx.supabase, ctx.organizationId, completo.data, autor));
    }
    if (o_que_faz !== undefined) {
      falha(await atualizarPerfilDaOrganizacao(ctx.supabase, ctx.organizationId, o_que_faz, autor));
    }
    if (interface_settings !== undefined) {
      falha(
        await atualizarInterfaceDaOrganizacao(ctx.supabase, ctx.organizationId, interface_settings, "admin", autor),
      );
    }
    return lerConfiguracaoDaOrganizacao(ctx.supabase, ctx.organizationId);
  },
};
