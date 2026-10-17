/**
 * As credenciais de provedor de IA da organização — só LEITURA (`ai_provider_credentials_safe`).
 *
 * Quem chama: `GET /api/v1/ai/credentials` (sessão OU token `dsk_…`) e a tool MCP `crm_list_ai_credentials`.
 *
 * ⚠️ SEGREDO DE PROVEDOR NUNCA VOLTA. A view `_safe` não expõe campo cifrado, e para quem NÃO é pessoa (uma chave
 * de API) saem também os últimos 4 caracteres da chave (`api_key_last4`) e quem a cadastrou: a chave só precisa do
 * `id` (para ligar uma versão de agente a ela), do provedor, do rótulo e do estado. Cadastrar, trocar, apagar e
 * revalidar chave continuam só pela sessão (exigem o segundo fator, e o texto da chave só entra por ali).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { codigoNuloParaOrganizacao } from "@/lib/automation/destino-recusado";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, base_url, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

export async function listarCredenciaisDeIA(
  supabase: SupabaseClient,
  organizationId: string,
  actor: Actor,
): Promise<{ ok: true; linhas: Array<Record<string, unknown>> } | { ok: false }> {
  const { data, error } = await supabase
    .from("ai_provider_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) return { ok: false };

  // Linhas gravadas antes do código único ainda podem trazer o código cru da régua de destino; a organização nunca
  // o recebe (oráculo de nomes internos).
  const linhas = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((linha) => {
    const base: Record<string, unknown> = { ...linha, validation_error: codigoNuloParaOrganizacao(linha.validation_error as string | null) };
    if (actor.type === "user") return base;
    const { api_key_last4: _final, created_by: _autor, ...semRastro } = base;
    void _final;
    void _autor;
    return semRastro;
  });
  return { ok: true, linhas };
}
