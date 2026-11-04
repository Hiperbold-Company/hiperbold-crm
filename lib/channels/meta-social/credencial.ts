/**
 * A credencial de uma conta do Instagram conectada pelo canal oficial: o id da
 * conta, a Página ligada (quando houver) e o token decifrado. Usada pela fila de
 * respostas a comentários e pela leitura dos posts da conta.
 *
 * A sessão é lida FILTRADA pela organização (o cliente é service role e ignora
 * a RLS): uma sessão de outra organização, arquivada, de Messenger ou sem token
 * responde `null`, como se não existisse. O token nunca sai daqui para log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";

export interface CredencialDoInstagram {
  contaId: string;
  paginaId: string | null;
  token: string;
}

/** Lança `meta_social_session_lookup_failed` só se a leitura do banco falhar. */
export async function credencialDaSessao(
  admin: SupabaseClient,
  organizationId: string,
  sessionId: string,
): Promise<CredencialDoInstagram | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, meta_social_platform, meta_social_account_id, meta_social_token_encrypted, meta_social_page_id")
    .eq("organization_id", organizationId)
    .eq("id", sessionId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .is("archived_at", null)
    .limit(1);
  if (error) throw new Error("meta_social_session_lookup_failed");
  const s = (
    (data ?? []) as {
      meta_social_platform: string;
      meta_social_account_id: string | null;
      meta_social_token_encrypted: string | null;
      meta_social_page_id?: string | null;
    }[]
  )[0];
  if (!s || s.meta_social_platform !== "instagram" || !s.meta_social_account_id || !s.meta_social_token_encrypted)
    return null;
  const token = await decryptWebhookSecret(admin, s.meta_social_token_encrypted);
  if (!token) return null;
  return { contaId: s.meta_social_account_id, paginaId: s.meta_social_page_id ?? null, token };
}
