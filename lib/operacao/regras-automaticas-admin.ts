/**
 * ADMINISTRAR as regras automáticas pela API — listar, criar, editar e apagar (`automation_rules`).
 *
 * Quem chama: as rotas `/api/v1/automation-rules/**` (sessão OU token `dsk_…`) e as tools MCP de
 * administração (`lib/mcp/tools/administracao-regras.ts`). Ligar/desligar sem mexer no resto continua em
 * `regras-automaticas.ts` (a capacidade `crm_set_automation_rule_active`).
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere papel/escopo (`manager`, como a tela) e entrega a
 * organização já resolvida. O cliente de uma chave é service role e BYPASSA a RLS: todo SELECT/UPDATE/DELETE
 * leva `organization_id` explícito (a rota antiga apagava só por `id`, protegida pela RLS da sessão).
 *
 * ⚠️ REGRA LIGADA É O ESTADO MAIS PERIGOSO DO SISTEMA (ver `regras-automaticas.ts`): ela dispara sozinha, para
 * sempre. Por isso a regra NASCE PAUSADA (o schema de criação nem aceita `is_active`) e ligar é uma edição
 * explícita, com autoria gravada na linha.
 *
 * ⚠️ SEGREDO DE `call_webhook` NUNCA SAI PARA UMA CHAVE. A configuração da ação guarda `secret_enc` (o segredo
 * cifrado). A tela precisa dele de volta para o editor reenviá-lo intacto; uma integração por token não: nas
 * respostas a ator que não é pessoa, `secret_enc` vira `has_secret: true`. Editar `actions` por token SUBSTITUI
 * a lista — um segredo que se queira manter é reenviado em `secret` (texto) e cifrado de novo.
 * O audit nunca leva `actions`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { logger } from "@/lib/logger";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import type { CreateAutomationRuleInput, UpdateAutomationRuleInput } from "@/lib/schemas";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";

export interface DepsDeRegras extends DepsDaOperacao {
  /** Service role, só para cifrar o segredo da ação (RPC com grant de servidor). */
  admin: SupabaseClient;
  /** Pessoa responsável (FK em auth.users): usuário da sessão ou dono da chave. */
  responsavel: string | null;
  t?: (texto: string) => string;
}

const tr = (deps: DepsDeRegras) => deps.t ?? ((texto: string) => texto);

function recusa(deps: DepsDeRegras, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, deps.requestId, message);
}

function falhaInterna(deps: DepsDeRegras, erro: unknown): ApiError {
  const causa =
    erro instanceof Error
      ? erro.message
      : erro && typeof erro === "object" && typeof (erro as { message?: unknown }).message === "string"
        ? (erro as { message: string }).message
        : "desconhecido";
  logger.error("api.falha_interna", { code: "internal_error", request_id: deps.requestId, causa });
  return recusa(deps, 500, "internal_error", MENSAGEM_DE_FALHA_INTERNA);
}

/** Pessoa vê o que a tela precisa; qualquer outro ator (chave) não recebe segredo cifrado de volta. */
function paraQuemLe(deps: DepsDeRegras, linha: Record<string, unknown>): Record<string, unknown> {
  if (deps.actor.type === "user" || !Array.isArray(linha.actions)) return linha;
  const actions = (linha.actions as Array<Record<string, unknown>>).map((a) => {
    const config = a?.config;
    if (!config || typeof config !== "object" || !("secret_enc" in (config as object))) return a;
    const { secret_enc: _cifrado, ...resto } = config as Record<string, unknown>;
    void _cifrado;
    return { ...a, config: { ...resto, has_secret: true } };
  });
  return { ...linha, actions };
}

const semCifra = (deps: DepsDeRegras, completa: boolean) =>
  recusa(
    deps,
    422,
    "encryption_unavailable",
    tr(deps)(
      completa
        ? "Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave. Enquanto isso, você pode criar a ação sem segredo."
        : "Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave.",
    ),
  );

export async function listarRegrasCompletas(deps: DepsDeRegras): Promise<unknown[]> {
  const { data, error } = await deps.supabase
    .from("automation_rules")
    .select("*")
    .eq("organization_id", deps.organizationId)
    .order("created_at", { ascending: false });
  if (error) throw falhaInterna(deps, error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((l) => paraQuemLe(deps, l));
}

/** A regra nasce PAUSADA, qualquer que seja o corpo. */
export async function criarRegra(deps: DepsDeRegras, input: CreateAutomationRuleInput) {
  // Secrets de call_webhook nunca ficam em claro no jsonb (migration 0041).
  const safeActions = await encryptRuleActionSecrets(deps.admin, input.actions);
  if (safeActions === null) throw semCifra(deps, true);

  const { data: created, error } = await deps.supabase
    .from("automation_rules")
    .insert({
      organization_id: deps.organizationId,
      created_by_user_id: deps.responsavel,
      name: input.name,
      trigger_event: input.trigger_event,
      conditions: input.conditions,
      actions: safeActions,
      // O gatilho de data do funil (#989) precisa que a regra guarde o funil, o campo e o N assinado.
      trigger_config: input.trigger_config ?? {},
    })
    .select("*")
    .single();
  if (error || !created) throw falhaInterna(deps, error ?? "automation_rule_insert_failed");

  const linha = created as unknown as { id: string } & Record<string, unknown>;
  void audit({
    action: "automation.rule_created",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "automation_rule",
    resourceId: linha.id,
    requestId: deps.requestId,
    metadata: { name: input.name, trigger_event: input.trigger_event },
  });
  return paraQuemLe(deps, linha);
}

export async function alterarRegra(deps: DepsDeRegras, id: string, entrada: UpdateAutomationRuleInput) {
  const { data: existing, error: fetchErr } = await deps.supabase
    .from("automation_rules")
    .select("id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr);
  if (!existing) throw recusa(deps, 404, "not_found", tr(deps)("Regra não encontrada."));

  // A autoria vai junto de TODA escrita: a tela precisa dizer quem ligou a regra (migration 0101).
  const patch: Record<string, unknown> = {
    ...entrada,
    updated_at: new Date().toISOString(),
    ...autoriaDaMudanca(deps.actor),
  };
  if (entrada.actions !== undefined) {
    const safeActions = await encryptRuleActionSecrets(deps.admin, entrada.actions);
    if (safeActions === null) throw semCifra(deps, false);
    patch.actions = safeActions;
  }

  const { data: updated, error: updErr } = await deps.supabase
    .from("automation_rules")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .select("*")
    .single();
  if (updErr || !updated) throw falhaInterna(deps, updErr ?? "automation_rule_update_failed");

  // `actions` fora do audit: a config de call_webhook carrega segredo em claro no input.
  const { actions: _actions, ...auditavel } = entrada;
  void _actions;
  void audit({
    action: "automation.rule_updated",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId: deps.requestId,
    metadata: { ...auditavel, ...(entrada.actions !== undefined ? { actions_changed: true } : {}) },
  });
  return paraQuemLe(deps, updated as unknown as Record<string, unknown>);
}

export async function apagarRegra(deps: DepsDeRegras, id: string): Promise<{ id: string }> {
  const { data: existing, error: fetchErr } = await deps.supabase
    .from("automation_rules")
    .select("id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (fetchErr) throw falhaInterna(deps, fetchErr);
  if (!existing) throw recusa(deps, 404, "not_found", tr(deps)("Regra não encontrada."));

  const { error: delErr } = await deps.supabase
    .from("automation_rules")
    .delete()
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (delErr) throw falhaInterna(deps, delErr);

  void audit({
    action: "automation.rule_deleted",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId: deps.requestId,
  });
  return { id };
}
