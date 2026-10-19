import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O fuso IANA da organização, lido da linha — para a rota que autentica por token
 * (a sessão já traz o fuso junto da organização ativa). O `organization_id` vem da
 * autenticação, nunca do cliente.
 *
 * Nunca lança: sem leitura, devolve `null` e o filtro de data conta o dia em UTC —
 * uma lista levemente deslocada é melhor que um 500 numa tela de consulta.
 */
export async function fusoDaOrganizacao(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", organizationId)
      .maybeSingle();
    const tz = (data as { timezone?: string | null } | null)?.timezone;
    return typeof tz === "string" && tz.trim() ? tz : null;
  } catch {
    return null;
  }
}
