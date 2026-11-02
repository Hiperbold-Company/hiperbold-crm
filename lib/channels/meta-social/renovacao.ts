/**
 * Renovação dos tokens longos do Instagram (60 dias). A Meta só renova token
 * com pelo menos 24h e ainda não vencido; a rodada pega os que vencem em menos
 * de 20 dias e foram renovados há mais de 24h. O token de Página do Messenger
 * não vence e fica de fora.
 *
 * Falha marca `metadata.token_erro`: o `checkHealth` do adapter passa a
 * responder FAILED e o vigia `channel-health` abre o aviso na Central — o
 * mesmo mecanismo dos outros canais, sem um segundo caminho de aviso.
 *
 * TODA escrita da rodada é CONDICIONAL ao `meta_social_token_refreshed_at` que
 * ela leu. Entre o select e o update a pessoa pode ter reconectado a conta (o
 * callback grava token, metadata e `refreshed_at` novos); um update só por `id`
 * gravaria por cima o `metadata` lido antes — com `token_erro` de uma falha que
 * já não vale, ou com o token velho. Com a condição, a reconexão vence: o
 * update casa zero linhas e a rodada segue para a próxima.
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
  meta_social_token_refreshed_at: string | null;
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
    .select("id, organization_id, meta_social_token_encrypted, meta_social_token_refreshed_at, metadata")
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
    // Uma linha que lança (rede, cifra, banco) não interrompe a rodada.
    try {
      const r = await renovarUma(admin, linha, agora, renovar);
      if (r === "renovada") resumo.renovadas += 1;
      else if (r === "falhou") resumo.falhas += 1;
    } catch {
      resumo.falhas += 1;
    }
  }
  return resumo;
}

/**
 * Update condicional: só casa se a linha ainda é a que a rodada leu (mesmo
 * `refreshed_at`). `false` = a linha mudou no meio (reconexão) ou o banco
 * recusou — nos dois casos nada foi sobrescrito.
 */
async function gravarSeAindaFor(
  admin: SupabaseClient,
  linha: Linha,
  patch: Record<string, unknown>,
): Promise<"gravou" | "mudou" | "erro"> {
  let q = admin
    .from("channel_sessions")
    .update(patch)
    .eq("organization_id", linha.organization_id)
    .eq("id", linha.id);
  q = linha.meta_social_token_refreshed_at
    ? q.eq("meta_social_token_refreshed_at", linha.meta_social_token_refreshed_at)
    : q.is("meta_social_token_refreshed_at", null);
  const { data, error } = await q.select("id");
  if (error) return "erro";
  return (data ?? []).length > 0 ? "gravou" : "mudou";
}

async function renovarUma(
  admin: SupabaseClient,
  linha: Linha,
  agora: Date,
  renovar: typeof renovarTokenInstagram,
): Promise<"renovada" | "falhou" | "ignorada"> {
  const marcarFalha = async (motivo: string) => {
    const r = await gravarSeAindaFor(admin, linha, { metadata: { ...(linha.metadata ?? {}), token_erro: motivo } });
    // Reconectada no meio: a falha é de um token que já não está em uso.
    return r === "mudou" ? "ignorada" : "falhou";
  };
  const token = linha.meta_social_token_encrypted
    ? await decryptWebhookSecret(admin, linha.meta_social_token_encrypted)
    : null;
  if (!token) return marcarFalha("credencial_nao_decifrou");
  let novo;
  try {
    novo = await renovar(token);
  } catch {
    return marcarFalha("meta_recusou_a_renovacao");
  }
  const cifrado = await encryptWebhookSecret(admin, novo.token);
  if (!cifrado) return marcarFalha("cifra_indisponivel");
  const expira = new Date(agora.getTime() + (novo.expiraEmSegundos ?? 60 * 24 * 3600) * 1000);
  const r = await gravarSeAindaFor(admin, linha, {
    meta_social_token_encrypted: cifrado,
    meta_social_token_expires_at: expira.toISOString(),
    meta_social_token_refreshed_at: agora.toISOString(),
    metadata: { ...(linha.metadata ?? {}), token_erro: null },
  });
  return r === "gravou" ? "renovada" : r === "mudou" ? "ignorada" : "falhou";
}
