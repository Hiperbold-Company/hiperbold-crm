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
import { ehSegredoPlaceholder, esquecerSessaoDoWebhook } from "@/lib/waha/sessao-do-webhook";

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
const ehPlaceholder = ehSegredoPlaceholder;

/**
 * Decifra o segredo gravado. `{ erro: true }` = o RPC falhou (passageiro);
 * `segredo: null` = não há segredo utilizável (placeholder ou curto demais).
 */
async function decifrarSegredo(
  admin: SupabaseClient,
  cifrado: string | null,
): Promise<{ erro: true } | { erro: false; segredo: string | null }> {
  if (ehPlaceholder(cifrado)) return { erro: false, segredo: null };
  const normalizado = cifrado!.startsWith("\\x") ? cifrado! : `\\x${cifrado}`;
  const dec = await admin.rpc("fn_decrypt_oauth", { ciphertext: normalizado });
  if (dec.error) return { erro: true };
  return { erro: false, segredo: typeof dec.data === "string" && dec.data.length >= MIN_SEGREDO ? dec.data : null };
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
  opcoes: {
    /**
     * `false` = só leitura: sessão no placeholder devolve `null` em vez de
     * ganhar segredo novo. Para quem só reenvia a config (PATCH /acervo): gerar
     * o segredo é papel de conectar/reconectar, não efeito colateral de um toggle.
     */
    gerarSegredo?: boolean;
  } = {},
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

    const cifrado = linha?.webhook_secret_encrypted ?? null;
    const lido = await decifrarSegredo(admin, cifrado);
    if (lido.erro) {
      logger.warn("[waha.webhook-da-sessao] não decifrei o segredo; webhook não tocado", {
        channel_session_id: alvo.channelSessionId,
      });
      return null;
    }
    let segredo = lido.segredo;
    if (!segredo && opcoes.gerarSegredo === false) return null;

    if (!segredo) {
      const novo = randomBytes(32).toString("hex");
      const novoCifrado = await encryptWebhookSecret(admin, novo);
      if (!novoCifrado) {
        logger.warn("[waha.webhook-da-sessao] cifra indisponível; webhook não registrado", {
          channel_session_id: alvo.channelSessionId,
        });
        return null;
      }
      // Compare-and-set: só grava se o banco AINDA tem o valor lido (o
      // placeholder). Duas reconexões ao mesmo tempo gerariam dois segredos, e
      // a que gravasse por último deixaria o WAHA da outra com a chave errada.
      // O filtro usa o MESMO texto que a leitura devolveu (o hex `\x00` do
      // bytea), que o PostgREST converte de volta para bytea na comparação.
      const cas = admin
        .from("channel_sessions")
        .update({ webhook_secret_encrypted: novoCifrado })
        .eq("organization_id", alvo.organizationId)
        .eq("id", alvo.channelSessionId)
        .eq("provider", "waha");
      const gravado = await (cifrado === null
        ? cas.is("webhook_secret_encrypted", null)
        : cas.eq("webhook_secret_encrypted", cifrado)
      ).select("id").maybeSingle();
      if (gravado.error) {
        logger.warn("[waha.webhook-da-sessao] não gravei o segredo; webhook não registrado", {
          channel_session_id: alvo.channelSessionId,
        });
        return null;
      }
      if (!gravado.data) {
        // 0 linhas: ou outra reconexão gravou primeiro (usa o segredo dela), ou
        // o filtro não casou com o banco ainda no placeholder. Logs distintos:
        // o segundo caso, se acontecer, deixa toda sessão nova sem webhook.
        segredo = await segredoDeQuemGravouPrimeiro(admin, alvo);
        if (!segredo) return null;
      } else {
        segredo = novo;
      }
      // A memória de 30 s da rota guardava o segredo `null` desta sessão.
      esquecerSessaoDoWebhook(`token:${token}`);
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

/**
 * Releitura depois de um compare-and-set que atingiu 0 linhas. Devolve o
 * segredo que a outra reconexão gravou, ou `null` (e loga por quê) quando não
 * há o que usar.
 */
async function segredoDeQuemGravouPrimeiro(
  admin: SupabaseClient,
  alvo: { organizationId: string; channelSessionId: string },
): Promise<string | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("webhook_secret_encrypted")
    .eq("organization_id", alvo.organizationId)
    .eq("id", alvo.channelSessionId)
    .eq("provider", "waha")
    .maybeSingle();
  const cifrado = (data as { webhook_secret_encrypted?: string | null } | null)?.webhook_secret_encrypted ?? null;
  if (error || !data) {
    logger.warn("[waha.webhook-da-sessao] não reli a sessão depois do compare-and-set; webhook não registrado", {
      channel_session_id: alvo.channelSessionId,
    });
    return null;
  }
  if (ehPlaceholder(cifrado)) {
    logger.warn("[waha.webhook-da-sessao] compare-and-set não casou e o banco segue no placeholder; webhook não registrado", {
      channel_session_id: alvo.channelSessionId,
    });
    return null;
  }
  const lido = await decifrarSegredo(admin, cifrado);
  if (lido.erro || !lido.segredo) {
    logger.warn("[waha.webhook-da-sessao] outra reconexão gravou o segredo, mas não o decifrei; webhook não registrado", {
      channel_session_id: alvo.channelSessionId,
    });
    return null;
  }
  logger.info("[waha.webhook-da-sessao] outra reconexão gravou o segredo primeiro; usando o dela", {
    channel_session_id: alvo.channelSessionId,
  });
  return lido.segredo;
}
