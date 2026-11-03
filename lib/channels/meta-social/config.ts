/**
 * A configuração do canal social oficial DESTA INSTALAÇÃO: o app da Meta (id +
 * App Secret), o `config_id` do login unificado do Instagram e o verify token do
 * webhook.
 *
 * O Instagram conecta pela "Instagram API com login unificado": o MESMO app da
 * Meta do Messenger, mais uma configuração do Facebook Login para Empresas
 * (token de usuário do sistema de integração empresarial). O app próprio do
 * Instagram (id + chave, colunas da 0984) não é mais lido — obsoleto desde a 0988.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started
 *
 * Mesmo molde de `lib/channels/meta/app.ts`, de onde vêm o App Secret e o
 * verify token (não se duplica a leitura deles): BANCO primeiro
 * (`platform_meta_app`, colunas `app_id` da 0984 e `unified_config_id` da 0988),
 * `.env` como PISO de rollback (`META_APP_ID`, `META_UNIFIED_CONFIG_ID`).
 *
 * NUNCA LANÇA. É lida a cada entrega do webhook e a cada clique em "Conectar";
 * a falta de configuração vira `null` em cada metade, e quem chama decide
 * (redireciona com `motivo=nao_configurado`, ou recusa a assinatura com 401).
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { appDaMeta, type AppDaMetaEmVigor } from "@/lib/channels/meta/app";

export interface AppOAuth {
  appId: string;
  appSecret: string;
}

/** O app da Meta + a configuração do login unificado (o `config_id` vai na URL do login). */
export interface AppDoLoginUnificado extends AppOAuth {
  configId: string;
}

export interface ConfigMetaSocial {
  /** Instagram: app da Meta + `config_id`. Sem os três, não há como conectar. */
  instagram: AppDoLoginUnificado | null;
  messenger: AppOAuth | null;
  /** O verify token do handshake (o mesmo do WhatsApp oficial: é o app da instalação). */
  verifyToken: string | null;
  /**
   * Segredos aceitos na assinatura (`X-Hub-Signature-256`) e no
   * `signed_request` da exclusão de dados. Com o login unificado só há o App
   * Secret do app da Meta (a doc do webhook: "signed with your app's App Secret").
   */
  segredos: string[];
  /** Ids dos apps desta instalação: um eco com `app_id` daqui é envio nosso. */
  appIds: string[];
}

export interface LinhaDoAppSocial {
  app_id: string | null;
  unified_config_id: string | null;
}

const texto = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Regra pura: precedência banco > `.env`, campo a campo, vazio = ausente. */
export function resolverConfigMetaSocial(
  linha: LinhaDoAppSocial | null,
  meta: AppDaMetaEmVigor,
  source: Record<string, string | undefined> = process.env,
): ConfigMetaSocial {
  const metaAppId = texto(linha?.app_id) || texto(source.META_APP_ID);
  const metaSecret = texto(meta.appSecret);
  const messenger = metaAppId && metaSecret ? { appId: metaAppId, appSecret: metaSecret } : null;
  const configId = texto(linha?.unified_config_id) || texto(source.META_UNIFIED_CONFIG_ID);
  const instagram = messenger && configId ? { ...messenger, configId } : null;

  const segredos = metaSecret ? [metaSecret] : [];
  const appIds = metaAppId ? [metaAppId] : [];
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
    // Duas leituras: um clone sem a 0988 devolve 42703 na do `config_id`, e
    // isso não pode levar junto o `app_id` (0984), que o Messenger usa.
    const { data, error } = await admin.from("platform_meta_app").select("app_id").eq("id", 1).maybeSingle();
    // Clone sem a 0984 devolve 42703 aqui: o `.env` assume, como na 0257.
    if (error || !data) return null;
    const { data: unificado } = await admin
      .from("platform_meta_app")
      .select("unified_config_id")
      .eq("id", 1)
      .maybeSingle();
    return {
      app_id: (data as { app_id: string | null }).app_id,
      unified_config_id: (unificado as { unified_config_id: string | null } | null)?.unified_config_id ?? null,
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
