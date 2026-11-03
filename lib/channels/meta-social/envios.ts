/**
 * Os mids que a Meta devolveu nos envios DESTA instalação (`meta_social_envios`,
 * migration 0987) — para a ingestão reconhecer o eco do próprio envio.
 *
 * Por que uma tabela, e não o `metadata` da mensagem nem uma linha por pedaço:
 *   - o eco de um pedaço pode chegar ANTES de o envio inteiro terminar (os
 *     pedaços saem em sequência) e antes de o handler gravar o `external_id`;
 *     o adapter não conhece a linha da mensagem, mas conhece a organização, a
 *     sessão e o mid — e grava na hora, pedaço por pedaço;
 *   - uma linha de `messages` por pedaço mudaria o que o operador vê (uma
 *     resposta virando várias) e o que as métricas contam;
 *   - a pergunta da ingestão é uma só, "este mid é nosso?", e responde por
 *     chave primária `(organization_id, mid)`.
 * A retenção é curta: o eco chega em segundos; o cron diário do canal poda o
 * que passou de `RETENCAO_DOS_ENVIOS_DIAS`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export const RETENCAO_DOS_ENVIOS_DIAS = 7;

/**
 * Grava o mid como envio nosso. Falhar aqui NÃO falha o envio — a mensagem já
 * saiu; o pior caso é o eco desse pedaço não ser reconhecido, que é o mundo de
 * antes desta tabela. 23505 = já registrado (retentativa), não é erro.
 */
export async function registrarEnvio(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; mid: string },
): Promise<void> {
  try {
    const { error } = await admin.from("meta_social_envios").insert({
      organization_id: input.organizationId,
      channel_session_id: input.channelSessionId,
      mid: input.mid,
    });
    if (error && error.code !== "23505") {
      logger.warn("[meta-social.envios] envio não registrado para reconhecer o eco", {
        organization_id: input.organizationId,
        codigo: error.code,
      });
    }
  } catch {
    // Best-effort, idem.
  }
}

/** Apaga os registros mais velhos que a retenção. Devolve quantos (0 em falha). */
export async function podarEnviosAntigos(admin: SupabaseClient, agora: Date): Promise<number> {
  const limite = new Date(agora.getTime() - RETENCAO_DOS_ENVIOS_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin.from("meta_social_envios").delete().lt("created_at", limite).select("mid");
  if (error) {
    logger.warn("[meta-social.envios] poda falhou", { codigo: error.code });
    return 0;
  }
  return (data ?? []).length;
}
