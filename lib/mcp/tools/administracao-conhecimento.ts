/**
 * Capacidades de ADMINISTRAR o material de conhecimento por chave de API — fase 3 da API (17/10/2026): ler,
 * cadastrar (FAQ ou texto de documento), editar e arquivar. (Listar já existe: `crm_list_knowledge_sources`.)
 *
 * ⚠️ AQUI HÁ TRADUÇÃO DE ARGUMENTO E NADA MAIS. A regra vive em `lib/ai/rag/administracao-fontes.ts`, o MESMO
 * núcleo das rotas `/api/v1/ai/knowledge/sources/**`, com o schema da tela.
 *
 * ⚠️ O PAPEL É O DA TELA (`manager`). Todas `apenasHumano`: o material é o que o agente diz ao cliente, e um
 * agente que escrevesse o próprio acervo se autorizaria a afirmar o que quisesse. `source_metadata` e `agent_id`
 * não são expostos: metadado livre aponta para arquivos do storage, e o acervo é da organização.
 * Envio de ARQUIVO e reindexação continuam só na tela.
 */
import { z } from "zod";

import {
  alterarFonteSchema,
  arquivarFonte,
  cadastrarFonte,
  criarFonteSchema,
  editarFonte,
  lerFonte,
  type DepsDeConhecimento,
} from "@/lib/ai/rag/administracao-fontes";
import { ApiError } from "@/lib/api/types";

import type { McpContext, McpToolDefinition } from "../types";

function depsDoConhecimento(ctx: McpContext): DepsDeConhecimento {
  return {
    supabase: ctx.supabase,
    admin: ctx.supabase,
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    requestId: ctx.requestId,
  };
}

function recusa(ctx: McpContext, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, ctx.requestId, message);
}

const itemShape = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional(),
  locale: z.string().optional(),
});

const idShape = { source_id: z.string().uuid() };

export const crmGetKnowledgeSource: McpToolDefinition<typeof idShape> = {
  name: "crm_get_knowledge_source",
  description:
    "Devolve um material de conhecimento e o conteúdo editável dele (para FAQ, os pares pergunta/resposta em `items`). " +
    "Leia antes de crm_update_knowledge_source: editar `items` SUBSTITUI a lista inteira.",
  inputSchema: idShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => lerFonte(depsDoConhecimento(ctx), input.source_id),
};

const createShape = {
  /** faq (pergunta/resposta) ou documento (texto corrido). conversas e catálogo são preenchidos pelo sistema. */
  source_type: z.string().min(1),
  name: z.string().min(2).max(120),
  items: z.array(itemShape).optional(),
  /** FAQ: texto com `## Pergunta:` / `## Resposta:`. Documento: o texto inteiro. */
  markdown_blob: z.string().optional(),
};

export const crmCreateKnowledgeSource: McpToolDefinition<typeof createShape> = {
  name: "crm_create_knowledge_source",
  description:
    "Cadastra um material no acervo da empresa: FAQ (items ou markdown_blob com pares pergunta/resposta) ou documento " +
    "(markdown_blob com o texto). Os assistentes só o usam depois que a versão publicada deles o incluir. Nome repetido " +
    "é recusado (409). A resposta diz se a indexação está habilitada (indexacao_habilitada): sem chave de embedding o " +
    "material fica parado. Exige papel manager.",
  inputSchema: createShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const parsed = criarFonteSchema.safeParse(input);
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Dados inválidos para o material.");
    return cadastrarFonte(depsDoConhecimento(ctx), parsed.data);
  },
};

const updateShape = {
  source_id: z.string().uuid(),
  name: z.string().min(2).max(120).optional(),
  /** FAQ: SUBSTITUI todos os pares. */
  items: z.array(itemShape).optional(),
};

export const crmUpdateKnowledgeSource: McpToolDefinition<typeof updateShape> = {
  name: "crm_update_knowledge_source",
  description:
    "Edita um material: nome e/ou os pares de uma FAQ (items SUBSTITUI a lista inteira — leia antes com " +
    "crm_get_knowledge_source). O que os assistentes dizem passa a refletir a mudança depois da reindexação. " +
    "Exige papel manager.",
  inputSchema: updateShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { source_id, ...campos } = input;
    const parsed = alterarFonteSchema.safeParse(
      Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined)),
    );
    if (!parsed.success) throw recusa(ctx, 422, "unprocessable_entity", "Dados inválidos para o material.");
    if (Object.keys(parsed.data).length === 0) {
      throw recusa(ctx, 422, "unprocessable_entity", "Diga o que mudar no material.");
    }
    return editarFonte(depsDoConhecimento(ctx), source_id, parsed.data);
  },
};

export const crmArchiveKnowledgeSource: McpToolDefinition<typeof idShape> = {
  name: "crm_archive_knowledge_source",
  description:
    "Arquiva um material: ele sai do acervo (os assistentes deixam de consultá-lo) e o nome fica livre. Não apaga os " +
    "arquivos originais. Exige papel manager.",
  inputSchema: idShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => arquivarFonte(depsDoConhecimento(ctx), input.source_id),
};
