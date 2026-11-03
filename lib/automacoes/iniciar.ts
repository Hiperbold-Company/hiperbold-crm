/**
 * Iniciar uma automação para um contato — a ÚNICA porta, `fn_automacao_iniciar`
 * (migration 0986). A função do banco decide reentrada (ignorar ou recomeçar),
 * cooldown, teto por hora, cadeia/ciclo entre automações, teto da organização
 * e idempotência por evento, sob o lock do contato.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ResultadoDoInicio =
  | "iniciada"
  | "reiniciada"
  | "ja_em_execucao"
  | "duplicada"
  | "inativa"
  | "contato_invalido"
  | "sem_inicio"
  | "em_espera"
  | "limite_por_hora"
  | "ciclo"
  | "cadeia_longa"
  | "limite_da_organizacao";

export interface InicioDaAutomacao {
  resultado: ResultadoDoInicio;
  enrollment_id: string | null;
}

export async function iniciarAutomacao(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    pointerId: string;
    contactId: string;
    vars: Record<string, unknown>;
    originEventId?: string | null;
    parentEnrollmentId?: string | null;
  },
): Promise<InicioDaAutomacao> {
  const { data, error } = await admin.rpc("fn_automacao_iniciar", {
    p_org: input.organizationId,
    p_pointer: input.pointerId,
    p_contact: input.contactId,
    p_vars: input.vars,
    p_origin_event_id: input.originEventId ?? null,
    p_parent_enrollment_id: input.parentEnrollmentId ?? null,
  });
  if (error) throw new Error(`fn_automacao_iniciar: ${error.message}`);
  const r = (data ?? {}) as { resultado?: string; enrollment_id?: string | null };
  return {
    resultado: (r.resultado ?? "inativa") as ResultadoDoInicio,
    enrollment_id: r.enrollment_id ?? null,
  };
}
