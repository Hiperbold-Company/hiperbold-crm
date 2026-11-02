/**
 * Renovação dos tokens longos do Instagram (60 dias). A Meta só renova token
 * com pelo menos 24h e ainda não vencido; a rodada pega os que vencem em menos
 * de 20 dias e foram renovados há mais de 24h. O token de Página do Messenger
 * não vence e fica de fora.
 *
 * Falha marca `metadata.token_erro`: o `checkHealth` do adapter passa a
 * responder FAILED e o vigia `channel-health` abre o aviso na Central — o
 * mesmo mecanismo dos outros canais, sem um segundo caminho de aviso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import { renovarTokenInstagram } from "./oauth";

export const JANELA_DE_RENOVACAO_MS = 20 * 24 * 60 * 60 * 1000;
export const IDADE_MINIMA_MS = 24 * 60 * 60 * 1000;
export const TETO_POR_RODADA = 100;

export interface ResumoDaRenovacao {
  examinadas: number;
  renovadas: number;
  falhas: number;
}

interface Linha {
  id: string;
  organization_id: string;
  meta_social_token_encrypted: string | null;
  metadata: Record<string, unknown> | null;
}

export async function renovarTokensDoInstagram(
  admin: SupabaseClient,
  agora: Date,
  renovar: typeof renovarTokenInstagram = renovarTokenInstagram,
): Promise<ResumoDaRenovacao> {
  const resumo: ResumoDaRenovacao = { examinadas: 0, renovadas: 0, falhas: 0 };
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, meta_social_token_encrypted, metadata")
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .eq("meta_social_platform", "instagram")
    .is("archived_at", null)
    .not("meta_social_token_encrypted", "is", null)
    .gt("meta_social_token_expires_at", agora.toISOString())
    .lt("meta_social_token_expires_at", new Date(agora.getTime() + JANELA_DE_RENOVACAO_MS).toISOString())
    .lte("meta_social_token_refreshed_at", new Date(agora.getTime() - IDADE_MINIMA_MS).toISOString())
    .order("meta_social_token_expires_at", { ascending: true })
    .limit(TETO_POR_RODADA);
  if (error || !data) return resumo;

  for (const linha of data as Linha[]) {
    resumo.examinadas += 1;
    const marcarFalha = async (motivo: string) => {
      resumo.falhas += 1;
      await admin
        .from("channel_sessions")
        .update({ metadata: { ...(linha.metadata ?? {}), token_erro: motivo } })
        .eq("organization_id", linha.organization_id)
        .eq("id", linha.id);
    };
    const token = linha.meta_social_token_encrypted
      ? await decryptWebhookSecret(admin, linha.meta_social_token_encrypted)
      : null;
    if (!token) {
      await marcarFalha("credencial_nao_decifrou");
      continue;
    }
    let novo;
    try {
      novo = await renovar(token);
    } catch {
      await marcarFalha("meta_recusou_a_renovacao");
      continue;
    }
    const cifrado = await encryptWebhookSecret(admin, novo.token);
    if (!cifrado) {
      await marcarFalha("cifra_indisponivel");
      continue;
    }
    const expira = new Date(agora.getTime() + (novo.expiraEmSegundos ?? 60 * 24 * 3600) * 1000);
    const { error: erroAoGravar } = await admin
      .from("channel_sessions")
      .update({
        meta_social_token_encrypted: cifrado,
        meta_social_token_expires_at: expira.toISOString(),
        meta_social_token_refreshed_at: agora.toISOString(),
        metadata: { ...(linha.metadata ?? {}), token_erro: null },
      })
      .eq("organization_id", linha.organization_id)
      .eq("id", linha.id);
    if (erroAoGravar) resumo.falhas += 1;
    else resumo.renovadas += 1;
  }
  return resumo;
}
