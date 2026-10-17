/**
 * ADMINISTRAR os fluxos de follow-up pela API — listar, ler, criar, editar, apagar, duplicar,
 * publicar, desativar e reverter.
 *
 * Quem chama: as rotas `/api/v1/ai/followup-flows/**` (sessão OU token `dsk_…`) e as tools MCP de
 * administração (`lib/mcp/tools/administracao-fase3.ts`). A tela usa as mesmas rotas. A regra é uma só:
 * duas implementações do "publicar" divergem no primeiro validador novo — e publicar põe mensagem
 * automática para cliente de verdade.
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere papel/escopo (`manager` para escrever, como a tela)
 * e entrega a organização já resolvida de fonte confiável. O cliente `admin` é service role e BYPASSA a
 * RLS: todo SELECT/UPDATE/DELETE leva `organization_id` explícito, e fluxo/versão de outra organização
 * responde 404, igual ao inexistente.
 *
 * ⚠️ `created_by` da versão tem FK em `auth.users`: quem passa `responsavel` entrega a PESSOA da sessão ou
 * o dono da chave — nunca o id do token.
 *
 * ⚠️ PUBLICAR NÃO ENVIA NADA NA HORA, mas arma o gatilho: a partir dele o motor passa a matricular
 * contatos e a mandar as mensagens do fluxo. A validação semântica roda aqui, na hora de virar a chave.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";

import type { FollowupFlowSurface } from "./api-schemas";
import { carregaEtapasCitadas } from "./etapas-citadas";
import type { FlowGraph } from "./graph-schema";
import { nomeDaCopia } from "./nome-da-copia";
import { publishFollowupFlowVersion } from "./publish";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";
import {
  algumCanalExigeModeloForaDaJanela,
  proximosDoGrafo,
  validateFlowForPublish,
  type RoteiroDoPublish,
} from "./validate-publish";

export interface DepsDeFollowup {
  /** Leitura/escrita comum: o cliente da sessão (RLS) ou o de servidor do token — ambos com filtro de organização. */
  supabase: SupabaseClient;
  /** Service role (publicar, módulo opcional). Nunca sem `organization_id` explícito. */
  admin: SupabaseClient;
  organizationId: string;
  actor: Actor;
  /** Pessoa responsável (FK em auth.users): usuário da sessão ou dono da chave. */
  responsavel: string | null;
  requestId: string;
  /** Tradução das mensagens de recusa (a sessão traduz; a tool passa a identidade). */
  t?: (texto: string) => string;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_COLUMNS = "id, name, status, active_version_id, handoff_policy, updated_at";
export const DETAIL_COLUMNS =
  "id, name, status, active_version_id, draft_graph, handoff_policy, trigger_config, surface, created_at, updated_at";

const tr = (deps: DepsDeFollowup) => deps.t ?? ((texto: string) => texto);

function recusa(
  deps: DepsDeFollowup,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError(status, code, details, deps.requestId, message);
}

/** Falha do banco: o erro de verdade vai para o log; quem chama só recebe a frase fixa (D-135). */
function falhaInterna(deps: DepsDeFollowup, erro: unknown, code = "internal_error"): ApiError {
  const causa =
    erro instanceof Error
      ? erro.message
      : typeof erro === "string"
        ? erro
        : erro && typeof erro === "object" && typeof (erro as { message?: unknown }).message === "string"
          ? (erro as { message: string }).message
          : "desconhecido";
  logger.error("api.falha_interna", { code, request_id: deps.requestId, causa });
  return recusa(deps, 500, code, MENSAGEM_DE_FALHA_INTERNA);
}

function naoEncontrado(deps: DepsDeFollowup): ApiError {
  return recusa(deps, 404, "not_found", tr(deps)("Fluxo não encontrado."));
}

export function idValido(id: string): boolean {
  return UUID_RX.test(id);
}

// ---------------------------------------------------------------------------
// leitura
// ---------------------------------------------------------------------------

/**
 * `surface: "atendimento"` lista os roteiros de atendimento; sem ele, só os fluxos do RELÓGIO — a tela de
 * Follow-ups, o seletor de fluxos do agente e a ação de webhook "inscrever" leem daqui.
 */
export async function listarFluxos(
  deps: DepsDeFollowup,
  opts: { surface?: "atendimento" } = {},
): Promise<unknown[]> {
  const base = deps.supabase
    .from("followup_flow_pointers")
    .select(LIST_COLUMNS)
    .eq("organization_id", deps.organizationId);
  const { data, error } = await (opts.surface === "atendimento"
    ? base.eq("surface", "atendimento")
    : base.neq("surface", "atendimento")
  ).order("updated_at", { ascending: false });
  if (error) throw falhaInterna(deps, error);
  return data ?? [];
}

/** O fluxo completo (rascunho, gatilho, política de handoff) e a linhagem de versões. */
export async function lerFluxo(deps: DepsDeFollowup, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await deps.supabase
    .from("followup_flow_pointers")
    .select(DETAIL_COLUMNS)
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (error) throw falhaInterna(deps, error);
  if (!data) throw naoEncontrado(deps);

  // `.limit()` deliberadamente evitado: volume por fluxo é baixo (1 insert por publish).
  const { data: versionRows, error: versionsErr } = await deps.supabase
    .from("followup_flow_versions")
    .select("id, created_at")
    .eq("organization_id", deps.organizationId)
    .eq("pointer_id", id)
    .order("created_at", { ascending: false });
  if (versionsErr) throw falhaInterna(deps, versionsErr);

  // Rascunho ausente COM versão publicada: a tela abre o que está NO AR (ver `lib/followup/rascunho.ts`).
  const draft_graph = await rascunhoDoFluxo(
    deps.supabase,
    data as unknown as { draft_graph: unknown; active_version_id: string | null },
    deps.organizationId,
  );

  return {
    ...(data as unknown as Record<string, unknown>),
    draft_graph,
    versions_count: versionRows?.length ?? 0,
    previous_version_id: versionRows?.[1]?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// escrita
// ---------------------------------------------------------------------------

function auditar(
  deps: DepsDeFollowup,
  action:
    | "followup_flow.created"
    | "followup_flow.updated"
    | "followup_flow.deleted"
    | "followup_flow.duplicated"
    | "followup_flow.published"
    | "followup_flow.disabled"
    | "followup_flow.rolled_back",
  id: string,
  metadata?: Record<string, unknown>,
): void {
  void audit({
    action,
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId: deps.requestId,
    ...(metadata ? { metadata } : {}),
  });
}

/** Cria o fluxo em RASCUNHO (sem grafo, gatilho `manual`). Não publica nem arma nada. */
export async function criarFluxo(
  deps: DepsDeFollowup,
  entrada: { name: string; surface?: FollowupFlowSurface },
): Promise<{ id: string } & Record<string, unknown>> {
  // Roteiro de atendimento é módulo opcional da instalação (doc 64): desligado, a porta não existe.
  if (entrada.surface === "atendimento" && !(await moduloLigado(deps.admin, "fluxos_atendimento"))) {
    throw naoEncontrado(deps);
  }
  const { data: created, error } = await deps.supabase
    .from("followup_flow_pointers")
    .insert({
      organization_id: deps.organizationId,
      name: entrada.name,
      ...(entrada.surface !== undefined ? { surface: entrada.surface } : {}),
    })
    .select("*")
    .single();
  if (error || !created) {
    if (error?.code === "23505") {
      throw recusa(deps, 409, "conflict", tr(deps)("Já existe um fluxo com este nome."));
    }
    throw falhaInterna(deps, error ?? "followup_flow_insert_failed");
  }
  const linha = created as unknown as { id: string } & Record<string, unknown>;
  auditar(deps, "followup_flow.created", linha.id, { name: entrada.name });
  return linha;
}

export async function alterarFluxo(
  deps: DepsDeFollowup,
  id: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  const { data: existing, error: fetchErr } = await deps.supabase
    .from("followup_flow_pointers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr);
  if (!existing) throw naoEncontrado(deps);

  if (Object.keys(patch).length === 0) {
    const { data: unchanged, error: reloadErr } = await deps.supabase
      .from("followup_flow_pointers")
      .select(DETAIL_COLUMNS)
      .eq("id", id)
      .eq("organization_id", deps.organizationId)
      .single();
    if (reloadErr || !unchanged) throw falhaInterna(deps, reloadErr ?? "reload_failed");
    return unchanged;
  }

  const { data: updated, error: updErr } = await deps.supabase
    .from("followup_flow_pointers")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .select(DETAIL_COLUMNS)
    .single();
  if (updErr || !updated) {
    if (updErr?.code === "23505") {
      throw recusa(deps, 409, "conflict", tr(deps)("Já existe um fluxo com este nome."));
    }
    // O banco recusa gatilho de relógio em roteiro de atendimento (0394, `followup_flow_pointers_roteiro_so_manual`).
    if (updErr?.code === "23514") {
      throw recusa(
        deps,
        422,
        "validation_failed",
        tr(deps)("Roteiro de atendimento começa por palavra-gatilho ou pelo roteador, não por gatilho de follow-up."),
      );
    }
    throw falhaInterna(deps, updErr ?? "followup_flow_update_failed");
  }
  auditar(deps, "followup_flow.updated", id, { fields_changed: Object.keys(patch) });
  return updated;
}

export async function apagarFluxo(deps: DepsDeFollowup, id: string): Promise<{ id: string }> {
  const { data: existing, error: fetchErr } = await deps.supabase
    .from("followup_flow_pointers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr);
  if (!existing) throw naoEncontrado(deps);

  // Enrollment referencia version_id; pointer referencia active_version_id. Soltar o relógio nessa ordem evita 23503.
  const { error: enrErr } = await deps.supabase
    .from("followup_enrollments")
    .delete()
    .eq("pointer_id", id)
    .eq("organization_id", deps.organizationId);
  if (enrErr) throw falhaInterna(deps, enrErr);

  const { error: unpinErr } = await deps.supabase
    .from("followup_flow_pointers")
    .update({ active_version_id: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (unpinErr) throw falhaInterna(deps, unpinErr);

  const { error: verErr } = await deps.supabase
    .from("followup_flow_versions")
    .delete()
    .eq("pointer_id", id)
    .eq("organization_id", deps.organizationId);
  if (verErr) throw falhaInterna(deps, verErr);

  const { error: delErr } = await deps.supabase
    .from("followup_flow_pointers")
    .delete()
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (delErr) throw falhaInterna(deps, delErr);

  auditar(deps, "followup_flow.deleted", id);
  return { id };
}

const SOURCE_COLUMNS = "id, name, draft_graph, trigger_config, handoff_policy, surface, active_version_id";

/** Clona o ponteiro como rascunho — nunca publica nem passa a mandar mensagem. */
export async function duplicarFluxo(deps: DepsDeFollowup, id: string): Promise<{ id: string } & Record<string, unknown>> {
  const { data: origem, error: fetchErr } = await deps.supabase
    .from("followup_flow_pointers")
    .select(SOURCE_COLUMNS)
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr);
  if (!origem) throw naoEncontrado(deps);

  const { data: nomes, error: nomesErr } = await deps.supabase
    .from("followup_flow_pointers")
    .select("name")
    .eq("organization_id", deps.organizationId);
  if (nomesErr) throw falhaInterna(deps, nomesErr);

  const draft_graph = await rascunhoDoFluxo(
    deps.supabase,
    origem as { draft_graph: unknown; active_version_id: string | null },
    deps.organizationId,
  );
  const nome = nomeDaCopia(
    String(origem.name),
    (nomes ?? []).map((r) => String((r as { name: string }).name)),
  );

  const { data: copia, error: insErr } = await deps.supabase
    .from("followup_flow_pointers")
    .insert({
      organization_id: deps.organizationId,
      name: nome,
      status: "draft",
      draft_graph,
      trigger_config: origem.trigger_config,
      handoff_policy: origem.handoff_policy,
      surface: origem.surface ?? "followup",
    })
    .select("*")
    .single();
  if (insErr || !copia) {
    if (insErr?.code === "23505") {
      throw recusa(deps, 409, "conflict", tr(deps)("Já existe um fluxo com este nome."));
    }
    throw falhaInterna(deps, insErr ?? "followup_flow_duplicate_failed");
  }
  const linha = copia as unknown as { id: string } & Record<string, unknown>;
  auditar(deps, "followup_flow.duplicated", linha.id, { source_pointer_id: id, name: nome });
  return linha;
}

/** `status='disabled'`. Já desativado é no-op (sem novo audit). */
export async function desativarFluxo(deps: DepsDeFollowup, id: string): Promise<unknown> {
  const { data: existing, error: fetchErr } = await deps.supabase
    .from("followup_flow_pointers")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr);
  if (!existing) throw naoEncontrado(deps);
  if (existing.status === "disabled") return { id, status: "disabled" };

  const { data: updated, error: updErr } = await deps.supabase
    .from("followup_flow_pointers")
    .update({ status: "disabled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .select("id, status, updated_at")
    .single();
  if (updErr || !updated) throw falhaInterna(deps, updErr ?? "followup_flow_disable_failed");
  auditar(deps, "followup_flow.disabled", id);
  return updated;
}

/**
 * Aponta o fluxo para uma versão JÁ existente dele (linhagem `pointer_id`), sem criar versão nova e sem forçar
 * `status='active'`: se estava desativado, continua desativado.
 */
export async function reverterFluxo(deps: DepsDeFollowup, id: string, versionId: string): Promise<unknown> {
  const { data: pointer, error: fetchErr } = await deps.supabase
    .from("followup_flow_pointers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr);
  if (!pointer) throw naoEncontrado(deps);

  const { data: version, error: versionErr } = await deps.supabase
    .from("followup_flow_versions")
    .select("id")
    .eq("id", versionId)
    .eq("organization_id", deps.organizationId)
    .eq("pointer_id", id)
    .maybeSingle();
  if (versionErr) throw falhaInterna(deps, versionErr);
  if (!version) throw recusa(deps, 404, "not_found", tr(deps)("Version não encontrada."));

  const { data: updated, error: updErr } = await deps.supabase
    .from("followup_flow_pointers")
    .update({ active_version_id: version.id, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .select("id, status, active_version_id, updated_at")
    .single();
  if (updErr || !updated) throw falhaInterna(deps, updErr ?? "followup_flow_rollback_failed");
  auditar(deps, "followup_flow.rolled_back", id, { version_id: version.id });
  return updated;
}

/**
 * Valida o `draft_graph` (estrutura e semântica) e publica atomicamente por `fn_publish_followup_flow_version`
 * (migration 0056; EXECUTE só para service role). 422 `validation_failed` com `details.errors` se o rascunho
 * faltar ou for reprovado.
 */
export async function publicarFluxo(deps: DepsDeFollowup, id: string): Promise<unknown> {
  const t = tr(deps);
  const admin = deps.admin;
  const orgId = deps.organizationId;

  const { data: pointer, error: fetchErr } = await admin
    .from("followup_flow_pointers")
    .select("id, draft_graph, trigger_config, surface")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr);
  if (!pointer) throw naoEncontrado(deps);
  if (!deps.responsavel) {
    throw recusa(deps, 403, "forbidden", "Não foi possível identificar quem responde por esta chave.");
  }

  // Roteiro de atendimento: só com o módulo ligado, e só começa por palavra-gatilho ou roteador — nunca pelo relógio.
  const surface = (pointer.surface ?? "followup") as FollowupFlowSurface;
  if (surface === "atendimento") {
    if (!(await moduloLigado(admin, "fluxos_atendimento"))) throw naoEncontrado(deps);
    const kind = (pointer.trigger_config as { kind?: string } | null)?.kind ?? "manual";
    if (kind !== "manual") {
      throw recusa(
        deps,
        422,
        "trigger_kind_not_implemented",
        t("Roteiro de atendimento começa por palavra-gatilho ou pelo roteador, não por gatilho de follow-up."),
      );
    }
  }

  // ⚠️ ALLOWLIST, NÃO DENYLIST: `trigger_config` é jsonb SEM CHECK e este publish lê a linha CRUA. Kind só entra
  // aqui DEPOIS de ter motor de enrollment vivo — senão o fluxo fica `active` e nunca matricula ninguém.
  const KINDS_COM_MOTOR = new Set([
    "manual",
    "webhook",
    "silence",
    "stage_change",
    "case_opened",
    "appointment_no_show",
    "inbound_after_silence",
    "lead_created",
  ]);
  const trigger = (pointer.trigger_config ?? { kind: "manual" }) as {
    kind?: string;
    params?: { stage_id?: string };
  };
  const triggerKind = trigger.kind ?? "manual";
  if (!KINDS_COM_MOTOR.has(triggerKind)) {
    throw recusa(
      deps,
      422,
      "trigger_kind_not_implemented",
      `O gatilho «${triggerKind}» não está disponível — use Etapa do funil, Silêncio ou Manual.`,
    );
  }

  // ⚠️ ETAPA QUE NÃO EXISTE MAIS É FLUXO MORTO COM CARA DE VIVO: a recusa é aqui, quando há quem corrija.
  if (triggerKind === "stage_change") {
    const stageId = trigger.params?.stage_id;
    if (!stageId || !UUID_RX.test(stageId)) {
      throw recusa(
        deps,
        422,
        "trigger_stage_missing",
        t("Escolha a etapa do funil que dispara este fluxo antes de publicar."),
      );
    }
    const { data: stage, error: stageErr } = await admin
      .from("crm_stages")
      .select("id, name, is_archived")
      .eq("id", stageId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (stageErr) throw falhaInterna(deps, stageErr);
    if (!stage) {
      throw recusa(
        deps,
        422,
        "trigger_stage_not_found",
        t("A etapa escolhida para o gatilho não existe mais neste funil — escolha outra."),
      );
    }
    if (stage.is_archived) {
      throw recusa(
        deps,
        422,
        "trigger_stage_archived",
        `A etapa «${stage.name}» está arquivada e nunca receberia um negócio — escolha uma etapa ativa.`,
      );
    }
  }

  if (!pointer.draft_graph) {
    throw recusa(deps, 422, "validation_failed", t("Fluxo não tem rascunho pronto para publicar."), {
      errors: [
        {
          node_id: null,
          code: "no_trigger",
          message: t("draft_graph ausente — monte o fluxo antes de publicar."),
        },
      ],
    });
  }

  const graph = pointer.draft_graph as unknown as FlowGraph;
  // A regra de etapa guarda o `stage_id`, e só o banco diz se a etapa existe e está ativa.
  const citadas = await carregaEtapasCitadas(admin, orgId, graph.nodes);
  if (!citadas.ok) throw falhaInterna(deps, citadas.mensagem);

  // Roteiro: para onde os OUTROS roteiros ativos encadeiam — recusa a publicação que fecharia um ciclo A → B → A.
  let roteiro: RoteiroDoPublish | undefined;
  if (surface === "atendimento") {
    const { data: ativos, error: ativosErr } = await admin
      .from("followup_flow_pointers")
      .select("id, name, active_version_id")
      .eq("organization_id", orgId)
      .eq("surface", "atendimento")
      .eq("status", "active")
      .neq("id", id);
    if (ativosErr) throw falhaInterna(deps, ativosErr);
    const versoes = (ativos ?? []).flatMap((r) => (r.active_version_id ? [r.active_version_id as string] : []));
    const grafos = new Map<string, unknown>();
    if (versoes.length > 0) {
      const { data: vs, error: vsErr } = await admin
        .from("followup_flow_versions")
        .select("id, graph")
        .eq("organization_id", orgId)
        .in("id", versoes);
      if (vsErr) throw falhaInterna(deps, vsErr);
      for (const v of vs ?? []) grafos.set(v.id as string, v.graph);
    }
    roteiro = {
      pointerId: id,
      encadeamentos: new Map(
        (ativos ?? []).map((r) => [
          r.id as string,
          { nome: r.name as string, proximos: proximosDoGrafo(grafos.get(r.active_version_id as string)) },
        ]),
      ),
    };
  }

  // O plano B da mensagem por IA só existe para canal com janela de 24 h.
  const { data: conexoes, error: conexoesErr } = await admin
    .from("channel_sessions")
    .select("provider")
    .eq("organization_id", orgId)
    .is("archived_at", null);
  if (conexoesErr) throw falhaInterna(deps, conexoesErr);
  const exigeModeloForaDaJanela = algumCanalExigeModeloForaDaJanela(
    (conexoes ?? []).map((c) => c.provider as string | null),
  );
  const validation = validateFlowForPublish(graph, {
    etapas: citadas.etapas,
    surface,
    roteiro,
    exigeModeloForaDaJanela,
  });
  if (!validation.ok) {
    throw recusa(deps, 422, "validation_failed", t("Fluxo reprovado na validação de publish."), {
      errors: validation.errors,
    });
  }

  const result = await publishFollowupFlowVersion(admin, {
    orgId,
    pointerId: id,
    graph,
    createdBy: deps.responsavel,
  });
  if (!result.ok) {
    if (result.code === "pointer_not_found") throw naoEncontrado(deps);
    throw falhaInterna(deps, result.message);
  }

  const { data: updatedPointer, error: reloadErr } = await admin
    .from("followup_flow_pointers")
    .select("id, status, active_version_id, updated_at")
    .eq("id", id)
    .eq("organization_id", orgId)
    .single();
  if (reloadErr || !updatedPointer) throw falhaInterna(deps, reloadErr ?? "followup_flow_reload_failed");

  auditar(deps, "followup_flow.published", id, { version_id: result.version_id });
  return updatedPointer;
}
