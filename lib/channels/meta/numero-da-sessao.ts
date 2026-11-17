/**
 * A credencial do canal oficial VIVO da organização, pronta para falar com a Meta (D-174).
 *
 * Mesma busca de `app/api/v1/channels/official/webhook/route.ts` (`buscarSessaoOficialViva`): a
 * sessão não arquivada da organização, escopada por `organization_id` (o cliente é de servidor e ignora
 * a RLS). Com `channelSessionId`, é aquela conexão; sem ele, a oficial mais antiga (tela de hoje; a fase
 * B passa o id sempre). O token sai decifrado só no retorno, e quem chama não o devolve ao navegador.
 *
 * `sessao_nao_encontrada` só quando um id foi pedido e não é desta organização (ou não é oficial viva):
 * a rota responde 404 sem dizer qual dos casos foi.
 */
import { buscarSessaoOficialViva } from "@/lib/channels/meta/sessao-oficial-viva";
import type { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export type CredenciaisDoNumero =
  | { ok: true; sessionId: string; phoneNumberId: string; wabaId: string; token: string }
  | { ok: false; erro: "no_meta_channel" | "credencial_ilegivel" | "sessao_nao_encontrada" };

export async function credenciaisDoCanalOficialVivo(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  channelSessionId?: string | null,
): Promise<CredenciaisDoNumero> {
  const { data } = await buscarSessaoOficialViva(
    admin,
    organizationId,
    "id, meta_phone_number_id, meta_waba_id, meta_token_encrypted",
    channelSessionId,
  );
  const sessao = data as {
    id: string;
    meta_phone_number_id: string | null;
    meta_waba_id: string | null;
    meta_token_encrypted: string | null;
  } | null;

  if (!sessao && channelSessionId) return { ok: false, erro: "sessao_nao_encontrada" };
  if (!sessao || !sessao.meta_phone_number_id || !sessao.meta_waba_id || !sessao.meta_token_encrypted) {
    return { ok: false, erro: "no_meta_channel" };
  }
  const token = await decryptWebhookSecret(admin, sessao.meta_token_encrypted);
  if (!token) return { ok: false, erro: "credencial_ilegivel" };
  return {
    ok: true,
    sessionId: sessao.id,
    phoneNumberId: sessao.meta_phone_number_id,
    wabaId: sessao.meta_waba_id,
    token,
  };
}

/**
 * O número (`phone_number_id`) da conexão oficial VIVA `channelSessionId` desta organização, ou
 * `null` se o id não é dela (ou não é oficial viva). Só lê o id: não decifra o token.
 *
 * Com várias conexões oficiais (17/11/2026), conectar um número NOVO cria outra conexão e não troca
 * nada. Só SUBSTITUI um número quem aponta uma conexão existente (o mesmo `channel_session_id`) e
 * manda número diferente: é essa a pergunta que a guarda de administrador faz aqui.
 */
export async function numeroDoCanalOficialVivo(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  channelSessionId: string,
): Promise<{ phoneNumberId: string | null } | null> {
  const { data } = await buscarSessaoOficialViva<{ id: string; meta_phone_number_id: string | null }>(
    admin,
    organizationId,
    "id, meta_phone_number_id",
    channelSessionId,
  );
  return data ? { phoneNumberId: data.meta_phone_number_id } : null;
}
