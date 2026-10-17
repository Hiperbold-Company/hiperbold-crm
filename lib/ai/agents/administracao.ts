/**
 * ADMINISTRAR os agentes de IA pela API — listar, ler, criar rascunho, nova versão, publicar, pausar.
 *
 * Quem chama: as rotas `/api/v1/ai/agents/**` (sessão OU token `dsk_…`) e as tools MCP de
 * administração (`lib/mcp/tools/agentes.ts`). A regra é uma só: duas implementações do "publicar"
 * divergem no primeiro validador novo, e o agente que a tela deixa publicar a API recusaria (ou o
 * contrário).
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere papel/escopo (`admin` para escrever, `manager`
 * para ler — o piso da tela) e entrega a organização já resolvida de fonte confiável. O cliente
 * `admin` deste módulo é service role e BYPASSA a RLS: todo SELECT/UPDATE leva `organization_id`
 * explícito, e agente/versão de outra organização responde 404, igual ao inexistente.
 *
 * ⚠️ PUBLICAR É ATO DE PRODUÇÃO: a partir dele o agente passa a responder clientes de verdade.
 * Por isso a conferência de capacidades, do escopo e da credencial roda na hora de virar a chave,
 * não só quando a versão foi salva (o catálogo e as conexões mudam entre uma coisa e outra).
 *
 * ⚠️ `created_by` tem FK em `auth.users`: quem passa `responsavel` entrega a PESSOA da sessão ou o
 * dono da chave — nunca o id do token.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { lerAmbiente } from "@/lib/instalacao/ambiente";

import { capacidadesDesconhecidas } from "./capacidades-conhecidas";
import { mcpAgentDraftRecords } from "./create-draft";
import { mensagemDoEscopo, validarEscopoDaVersao } from "./escopo";
import { publishAgentVersion } from "./publish";
import {
  PUBLISH_ERROR_CODES,
  agentMcpCreateSchema,
  versionCreateSchema,
  type VersionInput,
} from "./validation";

export interface DepsDeAgentes {
  /** Leitura: o cliente da sessão (RLS) ou o de servidor do token — ambos com filtro de organização. */
  supabase: SupabaseClient;
  /** Escrita: service role. Nunca sem `organization_id` explícito. */
  admin: SupabaseClient;
  organizationId: string;
  actor: Actor;
  /** Pessoa responsável (FK em auth.users): usuário da sessão ou dono da chave. */
  responsavel: string | null;
  requestId: string;
}

export const COLUNAS_DO_AGENTE =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, channel, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

const COLUNAS_DO_AGENTE_NA_LISTA =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at, versao_publicada:ai_agent_versions!ai_agents_published_version_id_fkey(provider, model)";

const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, cases_enabled, split_messages, split_max_chars, followup, operator_enabled, operator_model, operator_tool_ids, status, published_at, superseded_at, created_at, created_by,pipeline_ids,knowledge_source_ids,provisioning_origin";

function recusa(deps: DepsDeAgentes, status: number, code: string, message: string, details?: Record<string, unknown>) {
  return new ApiError(status, code, details, deps.requestId, message);
}

// ---------------------------------------------------------------------------
// leitura
// ---------------------------------------------------------------------------

/**
 * A listagem pede as colunas do cadastro MAIS o join da versão publicada. Existe porque
 * `useAgentsList` refaz a busca por esta via depois da primeira pintura: sem o join, o "modelo em
 * vigor" do cartão voltava a ser o id do CADASTRO no primeiro refetch. Duas fontes para a mesma
 * lista têm de pedir as mesmas colunas — por isso a tela, a rota e a tool passam todas por aqui.
 */
export async function listarAgentes(
  deps: DepsDeAgentes,
  opts: { incluirArquivados?: boolean } = {},
): Promise<unknown[]> {
  let query = deps.supabase
    .from("ai_agents")
    .select(COLUNAS_DO_AGENTE_NA_LISTA)
    .eq("organization_id", deps.organizationId);
  if (!opts.incluirArquivados) query = query.is("archived_at", null);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw recusa(deps, 500, "internal_error", "Erro ao listar agents.");
  return data ?? [];
}

/** O agente e as versões dele (da mais nova para a mais velha). */
export async function lerAgenteComVersoes(
  deps: DepsDeAgentes,
  agentId: string,
): Promise<{ agent: unknown; versions: unknown[] }> {
  const { data: agent, error } = await deps.supabase
    .from("ai_agents")
    .select(COLUNAS_DO_AGENTE)
    .eq("id", agentId)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (error) throw recusa(deps, 500, "internal_error", "Erro ao buscar agent.");
  if (!agent) throw recusa(deps, 404, "not_found", "Agent não encontrado.");

  const { data: versions, error: erroDasVersoes } = await deps.supabase
    .from("ai_agent_versions")
    .select(VERSION_COLUMNS)
    .eq("organization_id", deps.organizationId)
    .eq("agent_id", agentId)
    .order("version_number", { ascending: false });
  if (erroDasVersoes) throw recusa(deps, 500, "internal_error", "Erro ao listar versions.");
  return { agent, versions: versions ?? [] };
}

// ---------------------------------------------------------------------------
// criar agente (rascunho) e nova versão
// ---------------------------------------------------------------------------

/**
 * Cria um agente `mcp_agent` com a versão 1 em RASCUNHO. Não publica e não roteia nada: o agente só
 * responde cliente depois de `publicarVersaoDoAgente`. O escopo é conferido antes da primeira
 * escrita, então um pedido recusado não deixa agente órfão; se a versão falhar, o agente é arquivado.
 */
export async function criarAgenteMcp(
  deps: DepsDeAgentes,
  entrada: unknown,
): Promise<{ agent: { id: string }; version: { id: string } }> {
  const parsed = agentMcpCreateSchema.safeParse(entrada);
  if (!parsed.success) {
    throw recusa(deps, 422, "validation_failed", "Campos inválidos.", parsed.error.flatten() as never);
  }
  const input = parsed.data;
  if (!deps.responsavel) {
    throw recusa(deps, 403, "forbidden", "Não foi possível identificar quem responde por esta chave.");
  }

  const escopo = await validarEscopoDaVersao(deps.admin, deps.organizationId, input.version);
  if (!escopo.ok) throw recusa(deps, 422, "validation_failed", mensagemDoEscopo(escopo));

  const records = mcpAgentDraftRecords({ orgId: deps.organizationId, userId: deps.responsavel }, input);
  const { data: agentRow, error: agentError } = await deps.admin
    .from("ai_agents")
    .insert(records.agent)
    .select(COLUNAS_DO_AGENTE)
    .single();
  if (agentError || !agentRow) throw recusa(deps, 500, "internal_error", "Erro ao criar agent.");
  const agent = agentRow as unknown as { id: string };

  const { data: versionRow, error: versionError } = await deps.admin
    .from("ai_agent_versions")
    .insert(records.version)
    .select(VERSION_COLUMNS)
    .single();
  if (versionError || !versionRow) {
    await deps.admin
      .from("ai_agents")
      .update({ archived_at: new Date().toISOString() })
      .eq("organization_id", deps.organizationId)
      .eq("id", agent.id);
    throw recusa(deps, 500, "internal_error", "Erro ao criar versão inicial.");
  }
  const version = versionRow as unknown as { id: string };

  void audit({
    action: "ai_agent.created",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "ai_agent",
    resourceId: agent.id,
    requestId: deps.requestId,
    metadata: { kind: "mcp_agent", first_version_id: version.id, priority: input.priority },
  });
  return { agent: agentRow as never, version: versionRow as never };
}

async function agenteDaOrg(deps: DepsDeAgentes, agentId: string): Promise<{ kind: string }> {
  const { data } = await deps.admin
    .from("ai_agents")
    .select("id, kind, archived_at")
    .eq("id", agentId)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (!data || data.archived_at) throw recusa(deps, 404, "not_found", "Agent não encontrado.");
  return { kind: (data as { kind: string }).kind };
}

/** Salva uma versão nova em RASCUNHO (próximo número, com retentativa na corrida do índice único). */
export async function criarVersaoDoAgente(
  deps: DepsDeAgentes,
  agentId: string,
  entrada: unknown,
): Promise<unknown> {
  const parsed = versionCreateSchema.safeParse(entrada);
  if (!parsed.success) {
    throw recusa(deps, 422, "validation_failed", "Campos inválidos.", parsed.error.flatten() as never);
  }
  const v: VersionInput = parsed.data;
  if (!deps.responsavel) {
    throw recusa(deps, 403, "forbidden", "Não foi possível identificar quem responde por esta chave.");
  }
  await agenteDaOrg(deps, agentId);

  // ⚠️ FALHA FECHADA: `credential_id: null` significa "usa a chave da instalação". Se ela não existir
  // para este provedor, a versão seria publicada para morrer em toda mensagem — e o dono só
  // descobriria com o primeiro cliente. O schema valida FORMA; quem conhece o ambiente do servidor é
  // quem escreve.
  if (v.credential_id === null && lerAmbiente().chavesDeProvedor[v.provider] !== true) {
    throw recusa(
      deps,
      422,
      "credential_required",
      `Esta instalação não tem chave de ${v.provider} no ambiente. Cadastre uma chave em IA › Credenciais ou escolha outra empresa de inteligência artificial.`,
    );
  }

  // O escopo aponta para coisas que EXISTEM nesta organização. Sem esta conferência, um id de outra
  // organização (ou de um material apagado) entra no array, a versão é publicada, e o assistente não
  // acha nada — sem erro, com a tela mostrando a marcação como se estivesse valendo.
  const escopo = await validarEscopoDaVersao(deps.admin, deps.organizationId, {
    pipeline_ids: v.pipeline_ids,
    knowledge_source_ids: v.knowledge_source_ids,
    tool_ids: v.tool_ids,
    operator_tool_ids: v.operator_tool_ids,
  });
  if (!escopo.ok) throw recusa(deps, 422, "validation_failed", mensagemDoEscopo(escopo));

  // Insert com retentativa em 23505 (corrida com unique(agent_id, version_number)).
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const { data: maxRow } = await deps.admin
      .from("ai_agent_versions")
      .select("version_number")
      .eq("agent_id", agentId)
      .eq("organization_id", deps.organizationId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const numero = (maxRow?.version_number ?? 0) + 1;

    const { data, error } = await deps.admin
      .from("ai_agent_versions")
      .insert({
        organization_id: deps.organizationId,
        agent_id: agentId,
        version_number: numero,
        system_prompt: v.system_prompt,
        provider: v.provider,
        model: v.model,
        credential_id: v.credential_id,
        tool_ids: v.tool_ids,
        trigger_config: v.trigger_config ?? undefined,
        channel_session_id: v.channel_session_id,
        max_steps: v.max_steps,
        token_budget: v.token_budget,
        cost_budget_cents: v.cost_budget_cents,
        history_message_window: v.history_message_window,
        history_token_window: v.history_token_window,
        handoff_keywords: v.handoff_keywords,
        handoff_tool_enabled: v.handoff_tool_enabled,
        cases_enabled: v.cases_enabled,
        split_messages: v.split_messages,
        split_max_chars: v.split_max_chars,
        followup: v.followup,
        operator_enabled: v.operator_enabled,
        operator_model: v.operator_model,
        operator_tool_ids: v.operator_tool_ids,
        pipeline_ids: v.pipeline_ids,
        knowledge_source_ids: v.knowledge_source_ids,
        status: "draft",
        created_by: deps.responsavel,
      })
      .select(VERSION_COLUMNS)
      .single();

    if (!error && data) {
      void audit({
        action: "ai_agent.version_created",
        ...colunasDeAtorNoAudit(deps.actor),
        organizationId: deps.organizationId,
        resourceType: "ai_agent_version",
        resourceId: (data as unknown as { id: string }).id,
        requestId: deps.requestId,
        metadata: { agent_id: agentId, version_number: numero },
      });
      return data;
    }
    if (error?.code !== "23505") throw recusa(deps, 500, "internal_error", "Erro ao criar version.");
  }
  throw recusa(deps, 500, "internal_error", "Conflito de versionamento — tente novamente.");
}

// ---------------------------------------------------------------------------
// publicar e pausar
// ---------------------------------------------------------------------------

export interface PublicacaoFeita {
  agent_id: string;
  version_id: string;
  previous_version_id: string | null;
  published_at: string;
}

/**
 * Vira a chave: a versão passa a ser a publicada (a anterior vira `superseded`), de forma atômica
 * em `fn_publish_ai_agent_version` (Spec 10 §4.5). Valida credencial, canal, modelo e capacidades
 * ANTES do commit e devolve o motivo estável da recusa (`PublishErrorCode`).
 */
export async function publicarVersaoDoAgente(
  deps: DepsDeAgentes,
  agentId: string,
  versionId: string,
): Promise<PublicacaoFeita> {
  // Pré-checagem: as capacidades da versão existem no catálogo ATUAL? (o catálogo evolui — a
  // conferência é na hora de publicar, fora da transação SQL.)
  const { data: alvo } = await deps.admin
    .from("ai_agent_versions")
    .select("id, agent_id, organization_id, tool_ids, operator_tool_ids, status")
    .eq("id", versionId)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (!alvo || alvo.agent_id !== agentId) {
    throw recusa(deps, 404, "version_not_found", "Version não encontrada.");
  }

  const tools = (alvo.tool_ids ?? []) as string[];
  const invalidas = capacidadesDesconhecidas(tools);
  if (invalidas.length > 0) {
    throw recusa(deps, 422, "tool_id_invalid", "tool_ids contém ids inexistentes no catálogo MCP.", {
      invalid: invalidas,
    });
  }

  // A conexão pode ter sido desligada (ou a ferramenta sumido do cache) entre salvar a versão e
  // publicar agora: confere de novo na hora de virar a chave, não só quando a versão foi gravada.
  const escopo = await validarEscopoDaVersao(deps.admin, deps.organizationId, {
    tool_ids: tools,
    operator_tool_ids: (alvo.operator_tool_ids ?? []) as string[],
  });
  if (!escopo.ok) throw recusa(deps, 422, "validation_failed", mensagemDoEscopo(escopo));

  const r = await publishAgentVersion(deps.admin, {
    orgId: deps.organizationId,
    agentId,
    versionId,
  });
  if (!r.ok) {
    if (PUBLISH_ERROR_CODES.has(r.code as string)) {
      const status = r.code === "agent_not_found" || r.code === "version_not_found" ? 404 : 422;
      throw recusa(deps, status, r.code, "Validação de publish falhou.");
    }
    throw recusa(deps, 500, "internal_error", "Erro ao publicar.");
  }

  // event_log + audit fire-and-forget (depois do commit).
  void deps.admin
    .from("event_log")
    .insert({
      organization_id: deps.organizationId,
      event_type: "ai_agent.published",
      // NOT NULL sem default — ver `tests/unit/evento-de-publicacao-tem-dono.test.ts`.
      entity_kind: "ai_agent",
      payload: {
        agent_id: r.agent_id,
        version_id: r.version_id,
        previous_version_id: r.previous_version_id,
        published_at: r.published_at,
      },
    })
    .then(({ error }) => {
      if (error) console.error("[ai_agents/publish] event_log error", error.message);
    });

  void audit({
    action: "ai_agent.published",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "ai_agent",
    resourceId: agentId,
    requestId: deps.requestId,
    metadata: { version_id: r.version_id, previous_version_id: r.previous_version_id },
  });

  return {
    agent_id: r.agent_id,
    version_id: r.version_id,
    previous_version_id: r.previous_version_id,
    published_at: r.published_at,
  };
}

/** Pausa o agente: o atendimento automático para; a versão publicada fica registrada. */
export async function pausarAgente(
  deps: DepsDeAgentes,
  agentId: string,
): Promise<{ id: string; published_version_id: string | null; paused_at: string }> {
  const { data: existente } = await deps.admin
    .from("ai_agents")
    .select("id, published_version_id, archived_at")
    .eq("id", agentId)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (!existente) throw recusa(deps, 404, "not_found", "Agent não encontrado.");
  if (existente.archived_at) throw recusa(deps, 409, "state_conflict", "Agent arquivado.");

  const versaoAnterior = existente.published_version_id as string | null;
  const pausadoEm = new Date().toISOString();
  const { error } = await deps.admin
    .from("ai_agents")
    .update({ paused_at: pausadoEm, updated_at: pausadoEm })
    .eq("id", agentId)
    .eq("organization_id", deps.organizationId);
  if (error) throw recusa(deps, 500, "internal_error", "Erro ao pausar agent.");

  void audit({
    action: "ai_agent.paused",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "ai_agent",
    resourceId: agentId,
    requestId: deps.requestId,
    metadata: { previous_version_id: versaoAnterior },
  });
  return { id: agentId, published_version_id: versaoAnterior, paused_at: pausadoEm };
}
