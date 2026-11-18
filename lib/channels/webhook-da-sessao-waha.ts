/**
 * O webhook POR SESSÃO do WAHA: URL pública do CRM com o token da conexão, e o
 * segredo HMAC próprio da sessão.
 *
 * Por que existe: o webhook GLOBAL do WAHA (`WHATSAPP_HOOK_URL`) só alcança o
 * app pela rede interna, e há hospedagens (EasyPanel) em que o nome interno do
 * app tem `_` — que o validador de URL do WAHA recusa, derrubando o contêiner.
 * Então cada sessão leva o próprio webhook, registrado pelo CRM na config dela,
 * apontando para a rota por token (`app/api/v1/webhooks/waha/[token]`). A rota
 * global continua fechada.
 *
 * Segredo por sessão (e não o `WAHA_HMAC_SECRET` da instalação): um corpo
 * assinado para a sessão de uma organização não passa no token de outra.
 *
 * Só registra com `WAHA_WEBHOOK_BASE_URL` em https (http só fora de produção).
 * O kit self-host usa `http://app:3000` nessa variável para montar o webhook
 * GLOBAL no compose — e é a trava de https que o mantém como sempre foi, sem
 * entrega em dobro.
 *
 * Nunca lança e nunca põe o segredo em log: `null` = "não registre nada", e a
 * conexão segue como antes.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import type { WebhookDaSessao } from "@/lib/waha/client";
import { esquecerSessaoDoWebhook } from "@/lib/waha/sessao-do-webhook";

/** Abaixo disto é placeholder (o `'\x00'` com que a sessão nasce) ou lixo. */
const MIN_SEGREDO = 16;

/**
 * A base pública válida, sem barra final — ou `null`. Lida de `process.env` na
 * hora da chamada (como `getWahaClient`), não do `env` parseado no boot.
 */
export function baseDoWebhookDaSessao(): string | null {
  const bruta = (process.env.WAHA_WEBHOOK_BASE_URL ?? "").trim();
  if (!bruta) return null;
  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    return null;
  }
  const producao = process.env.NODE_ENV === "production";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !producao)) return null;
  return bruta.replace(/\/+$/, "");
}

export function urlDoWebhookDaSessao(base: string, token: string): string {
  return `${base}/api/v1/webhooks/waha/${encodeURIComponent(token)}`;
}

/** `'\x00'` (e o vazio) é o placeholder com que a reserva cria a sessão. */
function ehPlaceholder(cifrado: string | null | undefined): boolean {
  if (!cifrado) return true;
  const hex = cifrado.replace(/^\\x/, "");
  return /^0*$/.test(hex);
}

/**
 * Monta o webhook da sessão e garante que o segredo dela esteja GRAVADO (cifrado)
 * antes de ir ao WAHA. Sessão com placeholder ganha segredo novo; sessão com
 * segredo bom o reaproveita (reconectar não troca a assinatura em voo).
 *
 * Falha passageira de decifra NÃO gera segredo novo: regenerar e depois falhar
 * o PUT deixaria banco e WAHA com chaves diferentes na mesma URL, sem cura.
 */
export async function webhookDaSessaoWaha(
  admin: SupabaseClient,
  alvo: { organizationId: string; channelSessionId: string },
): Promise<WebhookDaSessao | null> {
  const base = baseDoWebhookDaSessao();
  if (!base) return null;
  try {
    const { data, error } = await admin
      .from("channel_sessions")
      .select("webhook_path_token, webhook_secret_encrypted")
      .eq("organization_id", alvo.organizationId)
      .eq("id", alvo.channelSessionId)
      .eq("provider", "waha")
      .maybeSingle();
    const linha = data as { webhook_path_token?: string | null; webhook_secret_encrypted?: string | null } | null;
    const token = linha?.webhook_path_token;
    if (error || !token) {
      logger.warn("[waha.webhook-da-sessao] sessão sem token; webhook não registrado", {
        channel_session_id: alvo.channelSessionId,
      });
      return null;
    }

    let segredo: string | null = null;
    const cifrado = linha?.webhook_secret_encrypted ?? null;
    if (!ehPlaceholder(cifrado)) {
      const normalizado = cifrado!.startsWith("\\x") ? cifrado! : `\\x${cifrado}`;
      const dec = await admin.rpc("fn_decrypt_oauth", { ciphertext: normalizado });
      if (dec.error) {
        logger.warn("[waha.webhook-da-sessao] não decifrei o segredo; webhook não tocado", {
          channel_session_id: alvo.channelSessionId,
        });
        return null;
      }
      if (typeof dec.data === "string" && dec.data.length >= MIN_SEGREDO) segredo = dec.data;
    }

    if (!segredo) {
      const novo = randomBytes(32).toString("hex");
      const novoCifrado = await encryptWebhookSecret(admin, novo);
      if (!novoCifrado) {
        logger.warn("[waha.webhook-da-sessao] cifra indisponível; webhook não registrado", {
          channel_session_id: alvo.channelSessionId,
        });
        return null;
      }
      const gravado = await admin
        .from("channel_sessions")
        .update({ webhook_secret_encrypted: novoCifrado })
        .eq("organization_id", alvo.organizationId)
        .eq("id", alvo.channelSessionId)
        .select("id")
        .maybeSingle();
      if (gravado.error || !gravado.data) {
        logger.warn("[waha.webhook-da-sessao] não gravei o segredo; webhook não registrado", {
          channel_session_id: alvo.channelSessionId,
        });
        return null;
      }
      // A memória de 30 s da rota guardava o segredo `null` desta sessão.
      esquecerSessaoDoWebhook(`token:${token}`);
      segredo = novo;
    }

    return { url: urlDoWebhookDaSessao(base, token), hmacKey: segredo };
  } catch (err) {
    logger.warn("[waha.webhook-da-sessao] falha ao preparar o webhook da sessão", {
      channel_session_id: alvo.channelSessionId,
      erro: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
