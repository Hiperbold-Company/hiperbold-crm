/**
 * Leituras de configuração por chave de API — fase 3 da API (17/10/2026): conexões de canal (números de
 * WhatsApp) e credenciais de provedor de IA. SÓ LEITURA nesta rodada.
 *
 * ⚠️ SEGREDO NUNCA VOLTA. Nenhuma das duas devolve token de número, endereço de webhook nem texto de chave de IA; para
 * uma chave de API a credencial sai também sem os últimos 4 caracteres e sem o autor. Conectar, parear, reconectar e
 * apagar número, e cadastrar, trocar, apagar e revalidar chave de IA, continuam só pela tela (segundo fator).
 *
 * ⚠️ Papel da tela: `viewer` para os canais (qualquer membro lista), `manager` para as credenciais. `apenasHumano`.
 */
import { listarCredenciaisDeIA } from "@/lib/ai/credenciais/listar";
import { ApiError } from "@/lib/api/types";
import { listarConexoesDeMensagem } from "@/lib/channels/listar-conexoes";

import type { McpToolDefinition } from "../types";

const vazio = {};

export const crmListChannelSessions: McpToolDefinition<typeof vazio> = {
  name: "crm_list_channel_sessions",
  description:
    "Lista os números de WhatsApp conectados da empresa (id, nome, telefone, situação e motivo, limite diário, se o aquecimento " +
    "terminou). O id (channel_session_id) é o que roteadores, regras e agentes usam para apontar um número. Não devolve segredo " +
    "nenhum. Conectar ou reparar número só pela tela.",
  inputSchema: vazio,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const { data, error } = await listarConexoesDeMensagem(ctx.supabase, ctx.organizationId);
    if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao listar as conexões.");
    return { conexoes: data ?? [] };
  },
};

export const crmListAiCredentials: McpToolDefinition<typeof vazio> = {
  name: "crm_list_ai_credentials",
  description:
    "Lista as chaves de provedor de IA cadastradas (id, provedor, rótulo, endereço base, se foi validada e quando, modelos " +
    "disponíveis, se está ativa). O id (credential_id) é o que uma versão de agente usa. NUNCA devolve o texto da chave nem " +
    "pedaço dela. Cadastrar ou trocar chave só pela tela. Exige papel manager.",
  inputSchema: vazio,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const lista = await listarCredenciaisDeIA(ctx.supabase, ctx.organizationId, ctx.actor);
    if (!lista.ok) throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao listar as credenciais.");
    return { credenciais: lista.linhas };
  },
};
