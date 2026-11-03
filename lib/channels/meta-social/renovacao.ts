/**
 * Validade do token do Instagram do canal social oficial.
 *
 * Pelo login unificado o token é de USUÁRIO DO SISTEMA de integração (SUAT), e
 * a validade é a da configuração do painel — o padrão é não vencer. Não há
 * renovação automática: a API de gestão desses tokens
 * (`/<CLIENT_BUSINESS_ID>/system_user_access_tokens`) exige a permissão
 * `business_management`, que a configuração não pede.
 * https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business
 *
 * Então: token SEM validade → nada a fazer. Token COM validade → 7 dias antes
 * de vencer a sessão é marcada para reconectar (`status = FAILED`,
 * `status_reason = token_vence_em_breve`). O `checkHealth` do adapter responde
 * FAILED por esse motivo, e o vigia `channel-health` abre o aviso na Central —
 * o mesmo mecanismo dos outros canais, sem um segundo caminho de aviso. A tela
 * mostra "Reconecte"; reconectar grava token novo e limpa o motivo.
 *
 * A escrita é CONDICIONAL ao `meta_social_token_refreshed_at` lido: se a pessoa
 * reconectou entre o select e o update, a reconexão vence e nada é marcado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";

export const AVISO_ANTES_DE_VENCER_MS = 7 * 24 * 60 * 60 * 1000;
export const TETO_POR_RODADA = 100;
export const MOTIVO_TOKEN_VENCE_EM_BREVE = "token_vence_em_breve";

export interface ResumoDaValidade {
  examinadas: number;
  marcadas: number;
}

interface Linha {
  id: string;
  organization_id: string;
  status_reason: string | null;
  meta_social_token_refreshed_at: string | null;
}

export async function marcarTokensPertoDeVencer(admin: SupabaseClient, agora: Date): Promise<ResumoDaValidade> {
  const resumo: ResumoDaValidade = { examinadas: 0, marcadas: 0 };
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, status_reason, meta_social_token_refreshed_at")
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .eq("meta_social_platform", "instagram")
    .is("archived_at", null)
    .not("meta_social_token_encrypted", "is", null)
    .lt("meta_social_token_expires_at", new Date(agora.getTime() + AVISO_ANTES_DE_VENCER_MS).toISOString())
    .order("meta_social_token_expires_at", { ascending: true })
    .limit(TETO_POR_RODADA);
  if (error || !data) return resumo;

  for (const linha of data as Linha[]) {
    // Já marcada numa rodada anterior: não é efeito novo.
    if (linha.status_reason === MOTIVO_TOKEN_VENCE_EM_BREVE) continue;
    resumo.examinadas += 1;
    let q = admin
      .from("channel_sessions")
      .update({
        status: "FAILED",
        status_reason: MOTIVO_TOKEN_VENCE_EM_BREVE,
        last_status_change_at: agora.toISOString(),
      })
      .eq("organization_id", linha.organization_id)
      .eq("id", linha.id);
    q = linha.meta_social_token_refreshed_at
      ? q.eq("meta_social_token_refreshed_at", linha.meta_social_token_refreshed_at)
      : q.is("meta_social_token_refreshed_at", null);
    const { data: gravadas, error: erro } = await q.select("id");
    if (!erro && (gravadas ?? []).length > 0) resumo.marcadas += 1;
  }
  return resumo;
}
