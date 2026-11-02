/**
 * A configuração do canal social oficial DESTA INSTALAÇÃO: o app do Instagram
 * (id + segredo), o app da Meta (id + App Secret) e o verify token do webhook.
 *
 * Mesmo molde de `lib/channels/meta/app.ts`, de onde vêm o App Secret e o
 * verify token (não se duplica a leitura deles): BANCO primeiro
 * (`platform_meta_app`, colunas da migration 0984), `.env` como PISO de rollback
 * (`META_APP_ID`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`).
 *
 * O par do Instagram só é servido inteiro e da mesma origem: id do banco com
 * segredo do `.env` é um app que não existe, e a troca do código falharia com
 * uma mensagem que ninguém liga à configuração.
 *
 * NUNCA LANÇA. É lida a cada entrega do webhook e a cada clique em "Conectar";
 * a falta de configuração vira `null` em cada metade, e quem chama decide
 * (redireciona com `motivo=nao_configurado`, ou recusa a assinatura com 401).
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { appDaMeta, type AppDaMetaEmVigor } from "@/lib/channels/meta/app";

export interface AppOAuth {
  appId: string;
  appSecret: string;
}

export interface ConfigMetaSocial {
  instagram: AppOAuth | null;
  messenger: AppOAuth | null;
  /** O verify token do handshake (o mesmo do WhatsApp oficial: é o app da instalação). */
  verifyToken: string | null;
  /**
   * Segredos aceitos na assinatura (`X-Hub-Signature-256`) e no
   * `signed_request` da exclusão de dados. A doc da Meta não é clara sobre
   * qual dos dois assina o webhook do Instagram com login do Instagram, então
   * vale qualquer um dos dois — sempre segredo da própria instalação.
   */
  segredos: string[];
  /** Ids dos apps desta instalação: um eco com `app_id` daqui é envio nosso. */
  appIds: string[];
}

export interface LinhaDoAppSocial {
  app_id: string | null;
  instagram_app_id: string | null;
  /** Já decifrado (ou null). */
  instagram_app_secret: string | null;
}

const texto = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Regra pura: precedência banco > `.env`, par inteiro, vazio = ausente. */
export function resolverConfigMetaSocial(
  linha: LinhaDoAppSocial | null,
  meta: AppDaMetaEmVigor,
  source: Record<string, string | undefined> = process.env,
): ConfigMetaSocial {
  const igDoBanco =
    texto(linha?.instagram_app_id) && texto(linha?.instagram_app_secret)
      ? { appId: texto(linha?.instagram_app_id), appSecret: texto(linha?.instagram_app_secret) }
      : null;
  const igDoEnv =
    texto(source.INSTAGRAM_APP_ID) && texto(source.INSTAGRAM_APP_SECRET)
      ? { appId: texto(source.INSTAGRAM_APP_ID), appSecret: texto(source.INSTAGRAM_APP_SECRET) }
      : null;
  const instagram = igDoBanco ?? igDoEnv;

  const metaAppId = texto(linha?.app_id) || texto(source.META_APP_ID);
  const metaSecret = texto(meta.appSecret);
  const messenger = metaAppId && metaSecret ? { appId: metaAppId, appSecret: metaSecret } : null;

  const segredos = [...new Set([metaSecret, instagram?.appSecret ?? ""].filter((s) => s !== ""))];
  const appIds = [...new Set([metaAppId, instagram?.appId ?? ""].filter((s) => s !== ""))];
  return { instagram, messenger, verifyToken: texto(meta.verifyToken) || null, segredos, appIds };
}

const TTL_MS = 30_000;

declare global {
  var __memoDaConfigMetaSocial:
    | { readonly valor: ConfigMetaSocial; readonly expiraEm: number }
    | null
    | undefined;
}

/** Chamada por quem ESCREVE a configuração (a tela da instalação). */
export function invalidarConfigMetaSocial(): void {
  globalThis.__memoDaConfigMetaSocial = null;
}

async function linhaDoBanco(): Promise<LinhaDoAppSocial | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("platform_meta_app")
      .select("app_id, instagram_app_id, instagram_app_secret_encrypted")
      .eq("id", 1)
      .maybeSingle();
    // Clone sem a 0984 devolve 42703 aqui: o `.env` assume, como na 0257.
    if (error || !data) return null;
    const row = data as {
      app_id: string | null;
      instagram_app_id: string | null;
      instagram_app_secret_encrypted: string | null;
    };
    const cifrado = texto(row.instagram_app_secret_encrypted);
    const segredo = cifrado ? await decryptWebhookSecret(admin, cifrado) : null;
    return {
      app_id: row.app_id,
      instagram_app_id: row.instagram_app_id,
      instagram_app_secret: segredo,
    };
  } catch (err) {
    logger.warn("[meta-social.config] leitura do banco falhou; vale o .env", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** A configuração em vigor. Nunca lança. */
export async function configMetaSocial(): Promise<ConfigMetaSocial> {
  const memo = globalThis.__memoDaConfigMetaSocial;
  if (memo && memo.expiraEm > Date.now()) return memo.valor;
  let meta: AppDaMetaEmVigor = { appSecret: null, verifyToken: null };
  try {
    meta = await appDaMeta();
  } catch {
    // appDaMeta não lança; o catch é cinto para a promessa de "nunca lança".
  }
  const valor = resolverConfigMetaSocial(await linhaDoBanco(), meta);
  globalThis.__memoDaConfigMetaSocial = { valor, expiraEm: Date.now() + TTL_MS };
  return valor;
}
