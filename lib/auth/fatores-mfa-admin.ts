/**
 * Remove os fatores de MFA de uma conta pela admin API (D-204).
 *
 * Quando uma conta cadastrada por e-mail sem verificação do CRM é reassumida por quem provou o endereço (volta do
 * Google, ou link de recuperação de senha), o fator TOTP que estiver nela foi cadastrado por quem criou a conta
 * sem provar o endereço: a pessoa real não o conhece, e ele a trancaria num desafio que ela não passa (ou, no
 * caso da troca de senha, no "AAL2 exigido"). Por isso sai junto com a senha.
 *
 * ⚠️ O GoTrue encerra TODAS as sessões da conta quando o fator removido estava VERIFICADO (documentado em
 * `GoTrueAdminMFAApi.deleteFactor` no auth-js). Quem chama precisa tratar `verificadosRemovidos > 0` como
 * "a sessão que acabou de abrir também caiu".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type AdminMinimo = Pick<SupabaseClient, "auth">;

export type RemocaoDosFatores =
  | { ok: true; removidos: number; verificadosRemovidos: number }
  | { ok: false };

export async function removerTodosOsFatores(admin: AdminMinimo, userId: string): Promise<RemocaoDosFatores> {
  const lista = await admin.auth.admin.mfa.listFactors({ userId });
  if (lista.error) return { ok: false };
  const fatores = lista.data?.factors ?? [];

  let removidos = 0;
  let verificadosRemovidos = 0;
  for (const fator of fatores) {
    const r = await admin.auth.admin.mfa.deleteFactor({ userId, id: fator.id });
    if (r.error) return { ok: false };
    removidos += 1;
    if (fator.status === "verified") verificadosRemovidos += 1;
  }
  return { ok: true, removidos, verificadosRemovidos };
}
