/**
 * A configuração de um funil — campos personalizados, motivos de ganho e perda,
 * reabertura e vocabulário — num ÚNICO lugar.
 *
 * Quem chama: a server action da tela (`app/actions/settings/updatePipelineConfig.ts`),
 * a rota `GET/PATCH /api/v1/pipelines/[id]/config` e as tools MCP de configuração
 * do funil. As três escrevem pelo MESMO `aplicarConfiguracaoDoFunil`, porque duas
 * implementações do merge de `settings` divergem no primeiro campo novo.
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere o seu portão antes (admin da
 * organização + MFA na action; `role:admin` + `mcp:write` no token) e entrega a
 * organização já resolvida de fonte confiável. Esta função só garante o que vale
 * para todas: o funil TEM de ser da organização informada — consulta filtrada por
 * `organization_id`, e funil de outra organização responde igual a inexistente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import {
  pipelineConfigPatchSchema,
  type PipelineConfigPatch,
} from "@/lib/schemas/settings";

export interface ConfiguracaoDoFunil {
  id: string;
  name: string;
  vocabulary: Record<string, unknown>;
  /** Só as chaves de configuração que esta superfície edita — o resto de `settings` fica de fora. */
  settings: {
    fields: unknown[];
    lost_reasons: unknown[];
    won_reasons: string[];
    won_reason_required: boolean;
    reabertura: "mesmo_registro" | "novo_negocio";
    reabertura_campos: string[] | null;
  };
}

export type ResultadoDaConfiguracao<T> =
  | { ok: true; dados: T }
  | { ok: false; error: string; details?: unknown };

type Linha = {
  id: string;
  name: string;
  vocabulary: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
};

function paraConfiguracao(row: Linha): ConfiguracaoDoFunil {
  const settings = row.settings ?? {};
  return {
    id: row.id,
    name: row.name,
    vocabulary: row.vocabulary ?? {},
    settings: {
      fields: Array.isArray(settings.fields) ? settings.fields : [],
      lost_reasons: Array.isArray(settings.lost_reasons) ? settings.lost_reasons : [],
      won_reasons: Array.isArray(settings.won_reasons) ? (settings.won_reasons as string[]) : [],
      won_reason_required: settings.won_reason_required === true,
      reabertura: settings.reabertura === "novo_negocio" ? "novo_negocio" : "mesmo_registro",
      reabertura_campos: Array.isArray(settings.reabertura_campos)
        ? (settings.reabertura_campos as string[])
        : null,
    },
  };
}

/** Lê a configuração de UM funil da organização. `not_found` para inexistente ou de outra organização. */
export async function lerConfiguracaoDoFunil(
  supabase: SupabaseClient,
  organizationId: string,
  pipelineId: string,
): Promise<ResultadoDaConfiguracao<ConfiguracaoDoFunil>> {
  const { data, error } = await supabase
    .from("crm_pipelines")
    .select("id, name, vocabulary, settings")
    .eq("id", pipelineId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "not_found" };
  return { ok: true, dados: paraConfiguracao(data as Linha) };
}

export interface AutorDaConfiguracao {
  actorUserId?: string | null;
  actorApiTokenId?: string | null;
}

/**
 * Aplica um patch de configuração e audita `pipeline.config_updated`.
 *
 * `vocabulary` faz MERGE (só as chaves enviadas mudam); cada chave de `settings`
 * enviada SUBSTITUI a anterior; as ausentes ficam como estão — e as demais
 * chaves de `settings` (que esta tela não conhece) são preservadas.
 */
export async function aplicarConfiguracaoDoFunil(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    pipelineId: string;
    patch: PipelineConfigPatch;
    autor: AutorDaConfiguracao;
    requestId?: string | null;
  },
): Promise<ResultadoDaConfiguracao<ConfiguracaoDoFunil>> {
  const { organizationId, pipelineId } = input;
  if (!pipelineId || typeof pipelineId !== "string") {
    return { ok: false, error: "invalid_request" };
  }
  const parsed = pipelineConfigPatchSchema.safeParse(input.patch);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const { data: row, error: readErr } = await supabase
    .from("crm_pipelines")
    .select("vocabulary, settings")
    .eq("id", pipelineId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: "not_found" };

  const nextVocabulary = parsed.data.vocabulary
    ? { ...((row.vocabulary as Record<string, unknown> | null) ?? {}), ...parsed.data.vocabulary }
    : ((row.vocabulary as Record<string, unknown> | null) ?? {});

  const currentSettings = (row.settings as Record<string, unknown> | null) ?? {};
  const nextSettings: Record<string, unknown> = { ...currentSettings };
  if (parsed.data.fields !== undefined) nextSettings.fields = parsed.data.fields;
  if (parsed.data.lost_reasons !== undefined) nextSettings.lost_reasons = parsed.data.lost_reasons;
  if (parsed.data.won_reasons !== undefined) nextSettings.won_reasons = parsed.data.won_reasons;
  if (parsed.data.won_reason_required !== undefined) {
    nextSettings.won_reason_required = parsed.data.won_reason_required;
  }
  if (parsed.data.reabertura !== undefined) nextSettings.reabertura = parsed.data.reabertura;
  if (parsed.data.reabertura_campos !== undefined) {
    nextSettings.reabertura_campos = parsed.data.reabertura_campos;
  }

  const { error } = await supabase
    .from("crm_pipelines")
    .update({ vocabulary: nextVocabulary, settings: nextSettings })
    .eq("id", pipelineId)
    .eq("organization_id", organizationId);
  if (error) return { ok: false, error: error.message };

  await audit({
    action: "pipeline.config_updated",
    actorUserId: input.autor.actorUserId ?? null,
    actorApiTokenId: input.autor.actorApiTokenId ?? null,
    organizationId,
    resourceType: "pipeline",
    resourceId: pipelineId,
    requestId: input.requestId ?? null,
    metadata: {
      vocabulary_changed: !!parsed.data.vocabulary,
      fields_count: parsed.data.fields?.length ?? null,
      lost_reasons_count: parsed.data.lost_reasons?.length ?? null,
      won_reasons_count: parsed.data.won_reasons?.length ?? null,
      won_reason_required: parsed.data.won_reason_required ?? null,
      reabertura: parsed.data.reabertura ?? null,
    },
  });

  return lerConfiguracaoDoFunil(supabase, organizationId, pipelineId);
}
