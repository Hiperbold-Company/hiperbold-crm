/**
 * ADMINISTRAR o material de conhecimento (`ai_knowledge_sources` + `ai_faq_items`) pela API — listar, ler,
 * cadastrar (FAQ ou texto de documento), editar e arquivar.
 *
 * Quem chama: as rotas `/api/v1/ai/knowledge/sources/**` (sessão OU token `dsk_…`) e as tools MCP de
 * administração (`lib/mcp/tools/administracao-conhecimento.ts`). Envio de ARQUIVO (`/upload`) e reindexação
 * continuam só na sessão.
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere papel/escopo (`manager` para escrever, como a tela) e
 * entrega a organização já resolvida. O cliente `admin` é service role e BYPASSA a RLS: todo SELECT/UPDATE/DELETE
 * leva `organization_id` explícito, e material/agente de outra organização responde 404.
 *
 * ⚠️ O MATERIAL É O QUE O AGENTE DIZ AO CLIENTE: o que se cadastra aqui entra no acervo que a versão publicada
 * de um assistente consulta (`knowledge_source_ids`). Por isso toda escrita é auditada com o autor.
 * Apagar ARQUIVA (`status='archived'` + `is_active=false`, juntos — a constraint
 * `ai_knowledge_sources_arquivada_nao_e_ativa` recusa pela metade).
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { temChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import { parseFaqMarkdown } from "@/lib/ai/rag/ingest/faq";
import { BUCKET_DE_CONHECIMENTO } from "@/lib/ai/rag/ingest/documento";
import {
  aceitaTextoColado,
  canonizarTipoDeFonte,
  ePerguntaEResposta,
  rotuloDoTipo,
} from "@/lib/ai/rag/tipos-de-fonte";
import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { logger } from "@/lib/logger";

export interface DepsDeConhecimento {
  /** Leitura: o cliente da sessão (RLS) ou o de servidor do token — ambos com filtro de organização. */
  supabase: SupabaseClient;
  /** Escrita e storage: service role. Nunca sem `organization_id` explícito. */
  admin: SupabaseClient;
  organizationId: string;
  actor: Actor;
  requestId: string;
  t?: (texto: string) => string;
}

/**
 * Tetos de tamanho do que entra no acervo pela API/MCP. Sem eles, uma chamada
 * só enfileirava texto sem limite para o indexador (custo de embedding e
 * memória do worker). Valores largos de propósito: nenhum material legítimo de
 * uma empresa chega perto. Compartilhados com as tools MCP.
 */
export const LIMITE_MARKDOWN_BLOB = 200_000;
export const LIMITE_PERGUNTA = 2_000;
export const LIMITE_RESPOSTA = 20_000;
export const LIMITE_ITENS_DE_FAQ = 500;

export const faqItemSchema = z.object({
  question: z.string().min(1).max(LIMITE_PERGUNTA),
  answer: z.string().min(1).max(LIMITE_RESPOSTA),
  tags: z.array(z.string()).optional().default([]),
  locale: z.string().optional().default("pt-BR"),
});

/**
 * O tipo chega como texto livre e é CANONIZADO na borda: um `z.enum` recusaria os nomes legados (`policy`,
 * `conversations`) que quem integrou por API ainda manda.
 */
export const criarFonteSchema = z.object({
  /** Opcional desde a 0181: o material é da organização. */
  agent_id: z.string().uuid().optional(),
  source_type: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  items: z.array(faqItemSchema).max(LIMITE_ITENS_DE_FAQ).optional(),
  markdown_blob: z.string().max(LIMITE_MARKDOWN_BLOB).optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional().default({}),
});
export type NovaFonte = z.infer<typeof criarFonteSchema>;

export const alterarFonteSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  items: z.array(faqItemSchema).max(LIMITE_ITENS_DE_FAQ).optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AlteracaoDeFonte = z.infer<typeof alterarFonteSchema>;

const SELECT_COLUNAS =
  "id, agent_id, organization_id, source_type, name, status, last_index_status, " +
  "last_index_error, last_indexed_at, chunks_count, is_active, source_metadata, " +
  "active_kb_version_id, ingested_at, created_at, updated_at";

const tr = (deps: DepsDeConhecimento) => deps.t ?? ((texto: string) => texto);

function recusa(deps: DepsDeConhecimento, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, deps.requestId, message);
}

function falhaInterna(deps: DepsDeConhecimento, erro: unknown, mensagem = MENSAGEM_DE_FALHA_INTERNA): ApiError {
  const causa =
    erro instanceof Error
      ? erro.message
      : erro && typeof erro === "object" && typeof (erro as { message?: unknown }).message === "string"
        ? (erro as { message: string }).message
        : "desconhecido";
  logger.error("api.falha_interna", { code: "internal_error", request_id: deps.requestId, causa });
  return recusa(deps, 500, "internal_error", mensagem);
}

/**
 * `source_metadata` é livre, mas `blob_path` NÃO é metadado: é o endereço do arquivo no storage que o indexador
 * lê com a chave de servidor. Um caminho de OUTRA organização faria o indexador ler o arquivo dela e pôr o
 * conteúdo no acervo desta — o que um `source_metadata` arbitrário permitiria.
 */
function exigirMetadadoSeguro(deps: DepsDeConhecimento, metadata: Record<string, unknown> | undefined): void {
  const caminho = metadata?.blob_path;
  if (caminho === undefined) return;
  if (typeof caminho !== "string" || !caminho.startsWith(`${deps.organizationId}/`) || caminho.includes("..")) {
    throw recusa(deps, 422, "validation_failed", "blob_path não é um arquivo desta organização.");
  }
}

function auditar(
  deps: DepsDeConhecimento,
  action: "ai.knowledge_source_created" | "ai.knowledge_source_updated" | "ai.knowledge_source_archived",
  id: string,
  metadata: Record<string, unknown>,
): void {
  void audit({
    action,
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "ai_knowledge_source",
    resourceId: id,
    requestId: deps.requestId,
    metadata,
  });
}

async function avisarOMotorDeIndexacao(
  deps: DepsDeConhecimento,
  id: string,
  agentId: string | null,
  sourceType: string,
): Promise<void> {
  const { error } = await deps.admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: id,
    p_payload: { knowledge_source_id: id, agent_id: agentId, source_type: sourceType },
    p_organization_id: deps.organizationId,
  } as never);
  if (error) logger.warn("ai.knowledge.emit_event_falhou", { request_id: deps.requestId, causa: error.message });
}

// ---------------------------------------------------------------------------
// leitura
// ---------------------------------------------------------------------------

export async function listarFontes(deps: DepsDeConhecimento): Promise<unknown[]> {
  const { data, error } = await deps.supabase
    .from("ai_knowledge_sources")
    .select(SELECT_COLUNAS)
    .eq("organization_id", deps.organizationId)
    .order("created_at", { ascending: false });
  if (error) throw falhaInterna(deps, error, "Erro ao listar os materiais.");
  return data ?? [];
}

/** O material e o conteúdo que dá para editar (o diálogo de edição não pode adivinhar o que já está lá). */
export async function lerFonte(deps: DepsDeConhecimento, id: string): Promise<Record<string, unknown>> {
  const { data: fonte, error } = await deps.supabase
    .from("ai_knowledge_sources")
    .select(SELECT_COLUNAS)
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (error) throw falhaInterna(deps, error, "Erro ao ler o material.");
  if (!fonte) throw recusa(deps, 404, "not_found", "Material não encontrado.");

  const { data: itens } = await deps.supabase
    .from("ai_faq_items")
    .select("question, answer, tags, locale, position")
    .eq("organization_id", deps.organizationId)
    .eq("knowledge_source_id", id)
    .order("position", { ascending: true });
  return { ...(fonte as unknown as Record<string, unknown>), items: itens ?? [] };
}

// ---------------------------------------------------------------------------
// escrita
// ---------------------------------------------------------------------------

export async function cadastrarFonte(
  deps: DepsDeConhecimento,
  input: NovaFonte,
): Promise<{ id: string; items_count: number; indexacao_habilitada: boolean }> {
  const t = tr(deps);
  exigirMetadadoSeguro(deps, input.source_metadata);
  const tipo = canonizarTipoDeFonte(input.source_type);
  if (tipo === null) {
    throw recusa(
      deps,
      422,
      "validation_failed",
      `Tipo de material desconhecido: "${input.source_type}". Use faq, documento, conversas ou catalogo.`,
    );
  }

  // Conteúdo mandado a um tipo que não o ingere era ACEITO e descartado em silêncio: recusar alto é a única
  // resposta honesta.
  const temConteudo = (input.items?.length ?? 0) > 0 || (input.markdown_blob?.trim().length ?? 0) > 0;
  if (temConteudo && !aceitaTextoColado(tipo)) {
    throw recusa(
      deps,
      422,
      "unprocessable_entity",
      `Material de ${rotuloDoTipo(tipo).toLowerCase()} não recebe conteúdo colado — ele é preenchido automaticamente.`,
    );
  }

  // `agent_id` é HISTÓRICO, mas continua validado: mandar o id de um agente de outra organização tem de doer.
  if (input.agent_id) {
    const { data: agent, error: agentErr } = await deps.supabase
      .from("ai_agents")
      .select("id")
      .eq("id", input.agent_id)
      .eq("organization_id", deps.organizationId)
      .maybeSingle();
    if (agentErr) throw falhaInterna(deps, agentErr, "Erro ao validar agent_id.");
    if (!agent) throw recusa(deps, 404, "not_found", t("Assistente não encontrado nesta organização."));
  }

  let faqItems: Array<{ question: string; answer: string; tags: string[]; locale: string }> = [];
  if (ePerguntaEResposta(tipo)) {
    if (input.items && input.items.length > 0) {
      faqItems = input.items.map((it) => ({ question: it.question, answer: it.answer, tags: it.tags, locale: it.locale }));
    } else if (input.markdown_blob) {
      faqItems = parseFaqMarkdown(input.markdown_blob);
      if (faqItems.length === 0) {
        throw recusa(
          deps,
          400,
          "invalid_request",
          t("Não achei nenhum par pergunta/resposta no texto. Use uma linha ## Pergunta: e uma ## Resposta: por item."),
        );
      }
    } else {
      throw recusa(deps, 400, "invalid_request", t("Cole o conteúdo do material antes de criar."));
    }
  } else if (tipo === "documento" && !input.markdown_blob?.trim()) {
    throw recusa(
      deps,
      400,
      "invalid_request",
      "Cole o texto do documento, ou envie o arquivo em /api/v1/ai/knowledge/sources/upload.",
    );
  }

  // TEXTO COLADO DE DOCUMENTO VIRA ARQUIVO `.md` no mesmo bucket dos arquivos e segue a mesma rota de extração.
  let metadata: Record<string, unknown> = { ...(input.source_metadata ?? {}) };
  if (tipo === "documento" && input.markdown_blob) {
    const blobPath = `${deps.organizationId}/${randomUUID()}.md`;
    const { error: upErr } = await deps.admin.storage
      .from(BUCKET_DE_CONHECIMENTO)
      .upload(blobPath, Buffer.from(input.markdown_blob, "utf8"), { contentType: "text/markdown", upsert: false });
    if (upErr) throw falhaInterna(deps, upErr, t("Erro ao guardar o conteúdo do material."));
    metadata = { ...metadata, blob_path: blobPath, ext: "md", origem: "texto_colado" };
  }

  const { data: ks, error: ksErr } = await deps.admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: deps.organizationId,
      agent_id: input.agent_id ?? null,
      source_type: tipo,
      name: input.name,
      status: "ready",
      is_active: true,
      source_metadata: metadata,
      ingested_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (ksErr || !ks) {
    // `ai_knowledge_sources_nome_unico_por_org`: dois materiais ativos não podem ter o mesmo nome.
    if (ksErr?.code === "23505") {
      throw recusa(deps, 409, "knowledge_source_name_in_use", `Já existe um material chamado "${input.name}". Escolha outro nome.`);
    }
    throw falhaInterna(deps, ksErr ?? "ai_knowledge_source_insert_failed", "Erro ao criar o material.");
  }
  const ksId = (ks as { id: string }).id;

  let itemsCount = 0;
  if (faqItems.length > 0) {
    const rows = faqItems.map((item, idx) => ({
      organization_id: deps.organizationId,
      knowledge_source_id: ksId,
      question: item.question,
      answer: item.answer,
      tags: item.tags,
      locale: item.locale,
      position: idx,
    }));
    const { error: itemsErr } = await deps.admin.from("ai_faq_items").insert(rows);
    if (itemsErr) {
      // Fonte sem item nenhum é fonte vazia: melhor desfazer do que deixar uma linha que promete conteúdo.
      await deps.admin.from("ai_knowledge_sources").delete().eq("id", ksId).eq("organization_id", deps.organizationId);
      throw falhaInterna(deps, itemsErr, t("Erro ao gravar o conteúdo do material."));
    }
    itemsCount = rows.length;
  }

  await avisarOMotorDeIndexacao(deps, ksId, input.agent_id ?? null, tipo);
  auditar(deps, "ai.knowledge_source_created", ksId, { name: input.name, source_type: tipo, items_count: itemsCount });

  // A resposta DIZ se a indexação vai acontecer (sem chave de embedding o material fica parado).
  const temChave = await temChaveDeEmbedding(deps.organizationId);
  return { id: ksId, items_count: itemsCount, indexacao_habilitada: temChave };
}

export async function editarFonte(
  deps: DepsDeConhecimento,
  id: string,
  input: AlteracaoDeFonte,
): Promise<{ id: string; items_count?: number }> {
  exigirMetadadoSeguro(deps, input.source_metadata);
  const { data: existing, error: fetchErr } = await deps.supabase
    .from("ai_knowledge_sources")
    .select("id, source_type, agent_id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr, "Erro ao verificar fonte.");
  if (!existing) throw recusa(deps, 404, "not_found", "Fonte de conhecimento não encontrada.");

  const ksRow = existing as { id: string; source_type: string; agent_id: string | null };
  const tipo = canonizarTipoDeFonte(ksRow.source_type);

  // Itens mandados a um tipo que não os ingere eram DESCARTADOS em silêncio — e antes de qualquer escrita.
  if (input.items !== undefined && tipo !== null && !aceitaTextoColado(tipo)) {
    throw recusa(
      deps,
      422,
      "unprocessable_entity",
      "Este material não é preenchido por texto colado — envie o arquivo ou aguarde a rotina que o alimenta.",
    );
  }

  const updatePayload: Record<string, unknown> = {};
  if (input.name !== undefined) updatePayload.name = input.name;
  if (input.source_metadata !== undefined) updatePayload.source_metadata = input.source_metadata;

  if (Object.keys(updatePayload).length > 0) {
    const { error: updateErr } = await deps.admin
      .from("ai_knowledge_sources")
      .update(updatePayload)
      .eq("id", id)
      .eq("organization_id", deps.organizationId);
    if (updateErr) {
      if (updateErr.code === "23505") {
        throw recusa(deps, 409, "knowledge_source_name_in_use", `Já existe um material chamado "${input.name}". Escolha outro nome.`);
      }
      throw falhaInterna(deps, updateErr, "Erro ao atualizar fonte.");
    }
  }

  let itemsCount: number | undefined;
  if (input.items !== undefined && tipo === "faq") {
    const { error: delErr } = await deps.admin
      .from("ai_faq_items")
      .delete()
      .eq("knowledge_source_id", id)
      .eq("organization_id", deps.organizationId);
    if (delErr) throw falhaInterna(deps, delErr, "Erro ao remover itens antigos.");

    if (input.items.length > 0) {
      const rows = input.items.map((item, idx) => ({
        organization_id: deps.organizationId,
        knowledge_source_id: id,
        question: item.question,
        answer: item.answer,
        tags: item.tags,
        locale: item.locale,
        position: idx,
      }));
      const { error: insertErr } = await deps.admin.from("ai_faq_items").insert(rows);
      if (insertErr) throw falhaInterna(deps, insertErr, "Erro ao inserir novos itens FAQ.");
      itemsCount = rows.length;
    } else {
      itemsCount = 0;
    }
  }

  await avisarOMotorDeIndexacao(deps, id, ksRow.agent_id, ksRow.source_type);
  auditar(deps, "ai.knowledge_source_updated", id, {
    fields: Object.keys(input),
    ...(itemsCount !== undefined ? { items_count: itemsCount } : {}),
  });
  return { id, ...(itemsCount !== undefined ? { items_count: itemsCount } : {}) };
}

/** Soft-delete: `status='archived'` e `is_active=false` JUNTOS (ver o aviso do topo). */
export async function arquivarFonte(deps: DepsDeConhecimento, id: string): Promise<{ id: string; status: "archived" }> {
  const { data: existing, error: fetchErr } = await deps.supabase
    .from("ai_knowledge_sources")
    .select("id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr, "Erro ao verificar fonte.");
  if (!existing) throw recusa(deps, 404, "not_found", "Fonte de conhecimento não encontrada.");

  const { error: archiveErr } = await deps.admin
    .from("ai_knowledge_sources")
    .update({ status: "archived", is_active: false })
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (archiveErr) throw falhaInterna(deps, archiveErr, "Erro ao arquivar o material.");

  auditar(deps, "ai.knowledge_source_archived", id, {});
  return { id, status: "archived" };
}
