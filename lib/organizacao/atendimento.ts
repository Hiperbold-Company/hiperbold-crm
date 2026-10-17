/**
 * A DISTRIBUIÇÃO DE ATENDIMENTO da organização — como as conversas são repartidas e quem enxerga o quê
 * (`organizations.settings.routing` + `settings.visibility_mode`).
 *
 * Quem chama: `GET|PATCH /api/v1/settings/routing` (sessão OU token `dsk_…`) e as tools MCP
 * `crm_get_attendance_routing` / `crm_update_attendance_routing`. A tela usa a mesma rota.
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI: cada porta confere `manager` (o piso da tela, spec 13 §4) e entrega a
 * organização já resolvida. A escrita vai SEMPRE pelo cliente de servidor — a única policy de escrita de
 * `organizations` é de platform admin, e o UPDATE de um manager pelo cliente da sessão casa ZERO linhas e
 * "dá sucesso" (issue #144) — e leva `organization_id` explícito.
 *
 * ⚠️ `visibility_mode` MUDA QUEM ENXERGA CADA NEGÓCIO E CONVERSA (RLS). Restringi-lo para `own` esconde dos
 * atendentes tudo o que não é deles; por isso o PATCH preserva o valor em vigor quando a chave não vem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { DEFAULT_VISIBILITY_MODE, type VisibilityMode } from "@/lib/auth/types";
import { logger } from "@/lib/logger";
import { atualizarSettingDaOrganizacao } from "@/lib/organizations/atualizar-setting";
import { routingConfigSchema, type AtendimentoConfigPatch } from "@/lib/schemas/routing";
import { mesclarSettingsDeAtendimento } from "@/lib/schemas/routing";

export interface DepsDeAtendimento {
  /** Leitura: o cliente da sessão (RLS) ou o de servidor do token — ambos com filtro de organização. */
  supabase: SupabaseClient;
  /** Escrita: service role. */
  admin: SupabaseClient;
  organizationId: string;
  actor: Actor;
  requestId: string;
}

/** Default aplicado quando settings.routing ainda não existe (G1-06b). */
const DEFAULT_ROUTING = routingConfigSchema.parse({});

function falhaInterna(deps: DepsDeAtendimento, erro: unknown): ApiError {
  const causa =
    erro instanceof Error
      ? erro.message
      : typeof erro === "string"
        ? erro
        : erro && typeof erro === "object" && typeof (erro as { message?: unknown }).message === "string"
          ? (erro as { message: string }).message
          : "desconhecido";
  logger.error("api.falha_interna", { code: "internal_error", request_id: deps.requestId, causa });
  return new ApiError(500, "internal_error", undefined, deps.requestId, MENSAGEM_DE_FALHA_INTERNA);
}

export async function lerAtendimento(deps: DepsDeAtendimento) {
  const { data: orgRow, error } = await deps.supabase
    .from("organizations")
    .select("settings")
    .eq("id", deps.organizationId)
    .maybeSingle();
  if (error) throw falhaInterna(deps, error);

  const settings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const routing = routingConfigSchema.catch(DEFAULT_ROUTING).parse(settings.routing ?? {});
  // O default é o MESMO de `lib/auth/types.ts`, o que a RLS assume quando a chave não existe.
  const visibility_mode = (settings.visibility_mode as VisibilityMode | undefined) ?? DEFAULT_VISIBILITY_MODE;
  return { ...routing, visibility_mode };
}

export async function gravarAtendimento(deps: DepsDeAtendimento, input: AtendimentoConfigPatch) {
  const { data: orgRow, error: readErr } = await deps.admin
    .from("organizations")
    .select("settings")
    .eq("id", deps.organizationId)
    .maybeSingle();
  if (readErr) throw falhaInterna(deps, readErr);
  if (!orgRow) throw new ApiError(404, "not_found", undefined, deps.requestId, "Organização não encontrada.");

  const currentSettings = (orgRow.settings as Record<string, unknown> | null) ?? {};
  const { visibility_mode } = input;
  // A mescla (não-destrutiva em dois níveis) mora em `lib/schemas/routing.ts`, onde o teste a lê.
  const { settings: nextSettings, routing } = mesclarSettingsDeAtendimento(currentSettings, input);

  // D-132: só as chaves que este PATCH mexe, gravadas pelo banco (não regravar o `settings` inteiro).
  const gravouRouting = await atualizarSettingDaOrganizacao(
    deps.admin,
    deps.organizationId,
    ["routing"],
    nextSettings.routing,
  );
  if (!gravouRouting.ok) throw falhaInterna(deps, gravouRouting.detalhe ?? gravouRouting.motivo);
  if (visibility_mode !== undefined) {
    const gravouVisibilidade = await atualizarSettingDaOrganizacao(
      deps.admin,
      deps.organizationId,
      ["visibility_mode"],
      visibility_mode,
    );
    if (!gravouVisibilidade.ok) throw falhaInterna(deps, gravouVisibilidade.detalhe ?? gravouVisibilidade.motivo);
  }

  void audit({
    action: "routing.config_changed",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "organization",
    resourceId: deps.organizationId,
    requestId: deps.requestId,
    metadata: { routing, ...(visibility_mode !== undefined ? { visibility_mode } : {}) },
  });

  return {
    ...routing,
    visibility_mode:
      visibility_mode ?? ((currentSettings.visibility_mode as VisibilityMode | undefined) ?? DEFAULT_VISIBILITY_MODE),
  };
}
