/**
 * ADMINISTRAR os roteadores de intenção (`ai_routers` + `ai_router_members`) — listar, ler, criar, editar,
 * apagar e definir os membros (agentes e fluxos por intenção).
 *
 * Quem chama: as rotas `/api/v1/ai/routers/**` (sessão OU token `dsk_…`) e as tools MCP de administração
 * (`lib/mcp/tools/administracao-roteadores.ts`). A regra é uma só.
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere papel/escopo (`admin` para escrever, `agent` para ler,
 * como a tela) e entrega a organização já resolvida. O cliente `admin` é service role e BYPASSA a RLS: todo
 * SELECT/UPDATE/DELETE leva `organization_id` explícito, e roteador/sessão/agente de outra organização
 * responde 404/422, igual ao inexistente.
 *
 * ⚠️ `created_by` tem FK em `auth.users`: quem passa `responsavel` entrega a PESSOA da sessão ou o dono da
 * chave — nunca o id do token.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PoolClient } from "pg";
import { z } from "zod";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { logger } from "@/lib/logger";

import { writeRouterMembers } from "./router-members";
import { replaceRouterMembersHttp } from "./router-members-http";

export interface DepsDeRoteadores {
  /** Service role. Nunca sem `organization_id` explícito. */
  /** Service role, criado só quando uma escrita precisa dele (o caminho Postgres direto não o abre). */
  admin: () => SupabaseClient;
  organizationId: string;
  actor: Actor;
  /** Pessoa responsável (FK em auth.users): usuário da sessão ou dono da chave. */
  responsavel: string | null;
  requestId: string;
  /** Tradução das mensagens de recusa (a sessão traduz; a tool passa a identidade). */
  t?: (texto: string) => string;
}

const ROUTER_LIST_COLUMNS = "id, name, channel_session_id, is_active, fallback_agent_id, updated_at";
const ROUTER_DETAIL_COLUMNS = "id, name, channel_session_id, is_active, config, fallback_agent_id";
const MEMBER_COLUMNS = "id, agent_id, intent_name, intent_description, examples, position, flow_pointer_id";

export const criarRoteadorSchema = z.object({
  name: z.string().min(1).max(120),
  channel_session_id: z.string().uuid(),
  fallback_agent_id: z.string().uuid().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type NovoRoteador = z.infer<typeof criarRoteadorSchema>;

export const alterarRoteadorSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  is_active: z.boolean().optional(),
  fallback_agent_id: z.string().uuid().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type AlteracaoDeRoteador = z.infer<typeof alterarRoteadorSchema>;

const membroSchema = z.object({
  agent_id: z.string().uuid(),
  intent_name: z.string().min(1).max(120),
  intent_description: z.string().min(1).max(2000),
  examples: z.array(z.string()).default([]),
  // Sem esta linha o Zod descartava o campo em silêncio e o vínculo intenção → roteiro nunca era gravado.
  flow_pointer_id: z.string().uuid().nullable().default(null),
});
export const membrosDoRoteadorSchema = z.object({ members: z.array(membroSchema) });

const tr = (deps: DepsDeRoteadores) => deps.t ?? ((texto: string) => texto);

function recusa(deps: DepsDeRoteadores, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, deps.requestId, message);
}

/** Falha do banco: o erro de verdade vai para o log; quem chama só recebe a frase fixa (D-135). */
function falhaInterna(deps: DepsDeRoteadores, erro: unknown): ApiError {
  const causa = erro instanceof Error ? erro.message : typeof erro === "string" ? erro : "desconhecido";
  logger.error("api.falha_interna", { code: "internal_error", request_id: deps.requestId, causa });
  return recusa(deps, 500, "internal_error", MENSAGEM_DE_FALHA_INTERNA);
}

function naoEncontrado(deps: DepsDeRoteadores): ApiError {
  return recusa(deps, 404, "not_found", tr(deps)("Router não encontrado."));
}

// ---------------------------------------------------------------------------
// leitura
// ---------------------------------------------------------------------------

export async function listarRoteadores(deps: DepsDeRoteadores): Promise<{ routers: unknown[] }> {
  const { data: routers, error: routersErr } = await deps.admin()
    .from("ai_routers")
    .select(ROUTER_LIST_COLUMNS)
    .eq("organization_id", deps.organizationId)
    .order("created_at", { ascending: false });
  if (routersErr) throw falhaInterna(deps, routersErr);

  const { data: memberRows, error: membersErr } = await deps.admin()
    .from("ai_router_members")
    .select("router_id")
    .eq("organization_id", deps.organizationId);
  if (membersErr) throw falhaInterna(deps, membersErr);

  const counts = new Map<string, number>();
  for (const m of (memberRows ?? []) as Array<{ router_id: string }>) {
    counts.set(m.router_id, (counts.get(m.router_id) ?? 0) + 1);
  }
  return {
    routers: (routers ?? []).map((r) => ({ ...(r as { id: string }), member_count: counts.get((r as { id: string }).id) ?? 0 })),
  };
}

export async function lerRoteador(
  deps: DepsDeRoteadores,
  id: string,
): Promise<{ router: unknown; members: unknown[] }> {
  const { data: router, error: routerErr } = await deps.admin()
    .from("ai_routers")
    .select(ROUTER_DETAIL_COLUMNS)
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (routerErr) throw falhaInterna(deps, routerErr);
  if (!router) throw naoEncontrado(deps);

  const { data: members, error: membersErr } = await deps.admin()
    .from("ai_router_members")
    .select(MEMBER_COLUMNS)
    .eq("router_id", id)
    .eq("organization_id", deps.organizationId)
    .order("position", { ascending: true });
  if (membersErr) throw falhaInterna(deps, membersErr);
  return { router, members: members ?? [] };
}

// ---------------------------------------------------------------------------
// escrita
// ---------------------------------------------------------------------------

function auditar(
  deps: DepsDeRoteadores,
  action: "ai.router_created" | "ai.router_updated" | "ai.router_deleted" | "ai.router_members_updated",
  id: string,
  metadata?: Record<string, unknown>,
): void {
  void audit({
    action,
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "ai_router",
    resourceId: id,
    requestId: deps.requestId,
    ...(metadata ? { metadata } : {}),
  });
}

/** Um roteador por número: `unique` parcial em `channel_session_id` onde ativo → 409, nunca 500 cru. */
export async function criarRoteador(deps: DepsDeRoteadores, input: NovoRoteador): Promise<{ id: string }> {
  // Arquivado não é destino válido. Tolerante à coluna ausente, e o erro NÃO vira 404 (ver lib/channels/archived).
  const base = () =>
    deps.admin()
      .from("channel_sessions")
      .select("id")
      .eq("id", input.channel_session_id)
      .eq("organization_id", deps.organizationId);
  const { data: session, error: sessionErr } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (sessionErr) throw recusa(deps, 500, "internal_error", tr(deps)("Erro ao verificar o número de WhatsApp."));
  if (!session) {
    throw recusa(deps, 404, "channel_session_not_found", tr(deps)("Número de WhatsApp não encontrado nesta organização."));
  }

  // O agente de reserva também tem de ser desta organização: a FK não conhece organização.
  if (input.fallback_agent_id) await agenteDaOrganizacao(deps, input.fallback_agent_id);

  const { data: created, error: insErr } = await deps.admin()
    .from("ai_routers")
    .insert({
      organization_id: deps.organizationId,
      name: input.name,
      channel_session_id: input.channel_session_id,
      fallback_agent_id: input.fallback_agent_id ?? null,
      ...(input.config !== undefined ? { config: input.config } : {}),
      created_by: deps.responsavel,
    })
    .select("id")
    .single();
  if (insErr || !created) {
    if (insErr?.code === "23505") {
      throw recusa(deps, 409, "router_already_exists", tr(deps)("Este número já tem um roteador ativo."));
    }
    throw falhaInterna(deps, insErr ?? "ai_router_insert_failed");
  }
  const id = (created as { id: string }).id;
  auditar(deps, "ai.router_created", id, { name: input.name, channel_session_id: input.channel_session_id });
  return { id };
}

async function agenteDaOrganizacao(deps: DepsDeRoteadores, agentId: string): Promise<void> {
  const { data, error } = await deps.admin()
    .from("ai_agents")
    .select("id")
    .eq("id", agentId)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (error) throw falhaInterna(deps, error);
  if (!data) {
    throw recusa(deps, 422, "validation_failed", tr(deps)("Um dos agentes não existe nesta organização."));
  }
}

export async function alterarRoteador(
  deps: DepsDeRoteadores,
  id: string,
  patch: AlteracaoDeRoteador,
): Promise<{ id: string }> {
  const { data: existing, error: loadErr } = await deps.admin()
    .from("ai_routers")
    .select("id, config")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (loadErr) throw falhaInterna(deps, loadErr);
  if (!existing) throw naoEncontrado(deps);

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.is_active !== undefined) update.is_active = patch.is_active;
  if (patch.fallback_agent_id !== undefined) {
    if (patch.fallback_agent_id !== null) await agenteDaOrganizacao(deps, patch.fallback_agent_id);
    update.fallback_agent_id = patch.fallback_agent_id;
  }
  if (patch.config !== undefined) {
    const currentConfig = ((existing as { config?: unknown }).config ?? {}) as Record<string, unknown>;
    update.config = { ...currentConfig, ...patch.config };
  }
  if (Object.keys(update).length === 0) return { id };

  const { error: updErr } = await deps.admin()
    .from("ai_routers")
    .update(update)
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (updErr) {
    if (updErr.code === "23505") {
      throw recusa(deps, 409, "router_already_exists", tr(deps)("Este número já tem um roteador ativo."));
    }
    throw falhaInterna(deps, updErr);
  }
  auditar(deps, "ai.router_updated", id, { patch: Object.keys(update) });
  return { id };
}

/** O cascade da FK (migration 0085) apaga `ai_router_members` junto. */
export async function apagarRoteador(deps: DepsDeRoteadores, id: string): Promise<{ id: string }> {
  const { data: existing, error: loadErr } = await deps.admin()
    .from("ai_routers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (loadErr) throw falhaInterna(deps, loadErr);
  if (!existing) throw naoEncontrado(deps);

  const { error: delErr } = await deps.admin()
    .from("ai_routers")
    .delete()
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (delErr) throw falhaInterna(deps, delErr);
  auditar(deps, "ai.router_deleted", id);
  return { id };
}

/** Substitui a lista INTEIRA de membros; `position` = índice do array. Tudo ou nada. */
export async function definirMembrosDoRoteador(
  deps: DepsDeRoteadores,
  id: string,
  members: z.infer<typeof membrosDoRoteadorSchema>["members"],
): Promise<{ count: number }> {
  let db: PoolClient | undefined;
  try {
    if (process.env.SUPABASE_DB_URL) {
      db = await getRequestPool().connect();
      await db.query("begin");
      await writeRouterMembers(db, deps.organizationId, id, members, "replace");
      await db.query("commit");
    } else {
      await replaceRouterMembersHttp(deps.admin(), deps.organizationId, id, members);
    }
  } catch (error) {
    if (db) await db.query("rollback");
    const message = error instanceof Error ? error.message : "";
    const code = (error as { code?: string }).code;
    const t = tr(deps);
    if (message === "router_not_found") throw naoEncontrado(deps);
    if (message === "member_agent_not_found") {
      throw recusa(deps, 422, "validation_failed", t("Um dos agentes não existe nesta organização."));
    }
    if (message === "member_flow_not_found") {
      throw recusa(deps, 422, "validation_failed", t("O fluxo de atendimento escolhido não existe nesta organização."));
    }
    if (message === "duplicate_intent_name" || code === "23505") {
      throw recusa(deps, 409, "duplicate_intent_name", t("Duas intenções não podem ter o mesmo nome no router."));
    }
    throw falhaInterna(deps, error);
  } finally {
    db?.release();
  }
  auditar(deps, "ai.router_members_updated", id, { count: members.length });
  return { count: members.length };
}
