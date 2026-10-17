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
 * a lista, mas o segredo já gravado de uma ação `call_webhook` é PRESERVADO quando a ação reenviada fica na
 * mesma posição, é `call_webhook` com a MESMA `url` e não traz `secret` novo (a chave nunca viu o `secret_enc`,
 * então não tinha como reenviá-lo). Sem esse casamento seguro a edição é recusada (422) em vez de zerar o
 * segredo em silêncio; `has_secret: false` remove o segredo de propósito. Um `secret_enc` vindo no corpo de
 * quem não é pessoa é sempre descartado: cifra só nasce de `secret` ou do que já está gravado.
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

type AcaoDeRegra = { type: string; config?: Record<string, unknown> };

/**
 * Para quem NÃO é pessoa (token/MCP): devolve `novas` com o `secret_enc` das ações já gravadas, casando por
 * posição + `call_webhook` + mesma `url`. Pura (sem banco) para ser testável. Lança 422 quando a ação diz que
 * tem segredo (`has_secret: true`) ou o tinha antes, mas não há como casar com segurança — nunca zera em silêncio.
 */
export function preservarSegredosDeWebhook(
  deps: Pick<DepsDeRegras, "requestId" | "t">,
  existentes: unknown,
  novas: AcaoDeRegra[],
): AcaoDeRegra[] {
  const antes = Array.isArray(existentes) ? (existentes as AcaoDeRegra[]) : [];
  return novas.map((acao, i) => {
    if (acao.type !== "call_webhook") return acao;
    const { secret_enc: _injetado, has_secret: temSegredo, ...config } = (acao.config ?? {}) as Record<string, unknown>;
    void _injetado;
    const limpa: AcaoDeRegra = { ...acao, config };
    const traziSegredoNovo = typeof config.secret === "string" && config.secret !== "";
    if (traziSegredoNovo || temSegredo === false) return limpa;

    const anterior = antes[i];
    const cifrado = anterior?.type === "call_webhook" ? anterior.config?.secret_enc : undefined;
    const tinhaSegredo = typeof cifrado === "string" && cifrado !== "";
    if (!tinhaSegredo) {
      // O mesmo endereço, com segredo gravado, em OUTRA posição: a ação foi reordenada e o casamento
      // por posição não vale. Tratar como ação nova perderia o segredo em silêncio.
      const moveuDePosicao = antes.some(
        (a, j) =>
          j !== i &&
          a?.type === "call_webhook" &&
          typeof a.config?.secret_enc === "string" &&
          a.config.secret_enc !== "" &&
          a.config.url === config.url,
      );
      if (moveuDePosicao) {
        throw new ApiError(
          422,
          "validation_failed",
          undefined,
          deps.requestId,
          (deps.t ?? ((x: string) => x))(
            `A ação ${i + 1} (call_webhook) mudou de posição e já tinha segredo: reenvie o segredo em "secret" para guardá-lo, ou envie "has_secret": false para removê-lo.`,
          ),
        );
      }
      if (temSegredo === true) {
        throw new ApiError(
          422,
          "validation_failed",
          undefined,
          deps.requestId,
          (deps.t ?? ((x: string) => x))(
            `A ação ${i + 1} (call_webhook) diz ter segredo, mas não há segredo gravado nessa posição. Reenvie o segredo em "secret".`,
          ),
        );
      }
      return limpa;
    }
    if (anterior?.config?.url !== config.url) {
      throw new ApiError(
        422,
        "validation_failed",
        undefined,
        deps.requestId,
        (deps.t ?? ((x: string) => x))(
          `A ação ${i + 1} (call_webhook) mudou de endereço ou de posição e já tinha segredo: reenvie o segredo em "secret" para guardá-lo, ou envie "has_secret": false para removê-lo.`,
        ),
      );
    }
    return { ...limpa, config: { ...config, secret_enc: cifrado } };
  });
}

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
  const safeActions = await encryptRuleActionSecrets(
    deps.admin,
    deps.actor.type === "user" ? input.actions : preservarSegredosDeWebhook(deps, [], input.actions),
  );
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
    .select("id, actions")
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
    // Pessoa: o editor reenvia o `secret_enc` que recebeu. Chave: nunca o recebeu, então o servidor o
    // reaproveita do que está gravado (ou recusa) — e descarta qualquer `secret_enc` vindo no corpo.
    const reenviadas =
      deps.actor.type === "user"
        ? entrada.actions
        : preservarSegredosDeWebhook(deps, (existing as { actions?: unknown }).actions, entrada.actions);
    const safeActions = await encryptRuleActionSecrets(deps.admin, reenviadas);
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
