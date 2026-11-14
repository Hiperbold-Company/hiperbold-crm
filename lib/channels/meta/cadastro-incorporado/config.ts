/**
 * A configuração do Cadastro Incorporado do WhatsApp (Embedded Signup) DESTA
 * INSTALAÇÃO: o id do app da Meta, o App Secret (que troca o código pelo token) e
 * o `config_id` da configuração do Facebook Login para Empresas do tipo WhatsApp
 * (migration 1014, `platform_meta_app.whatsapp_config_id`).
 *
 * Mesmo molde de `lib/channels/meta-social/config.ts`: BANCO primeiro, `.env` como
 * PISO de rollback (`META_APP_ID`, `META_WHATSAPP_CONFIG_ID`), campo a campo, vazio
 * = ausente. O App Secret vem de `appDaMeta()` (não se duplica a leitura dele).
 *
 * Leitura PRÓPRIA da coluna nova: um clone sem a 1014 devolve 42703 nela, e isso
 * não pode levar junto o `app_id`; aqui a ausência só quer dizer "use o `.env`".
 *
 * NUNCA LANÇA. Sem os três valores, devolve `null`, e a rota responde
 * `nao_configurado`.
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { appDaMeta } from "@/lib/channels/meta/app";

export interface ConfigDoCadastroIncorporado {
  appId: string;
  appSecret: string;
  configId: string;
}

export interface LinhaDoCadastroIncorporado {
  app_id: string | null;
  whatsapp_config_id: string | null;
}

const texto = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Regra pura: banco > `.env`, campo a campo; sem qualquer um dos três, `null`. */
export function resolverConfigDoCadastroIncorporado(
  linha: LinhaDoCadastroIncorporado | null,
  appSecret: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): ConfigDoCadastroIncorporado | null {
  const appId = texto(linha?.app_id) || texto(env.META_APP_ID);
  const configId = texto(linha?.whatsapp_config_id) || texto(env.META_WHATSAPP_CONFIG_ID);
  const segredo = texto(appSecret);
  if (!appId || !configId || !segredo) return null;
  return { appId, appSecret: segredo, configId };
}

const TTL_MS = 30_000;

declare global {
  var __memoDaConfigDoCadastroIncorporado:
    | { readonly valor: ConfigDoCadastroIncorporado | null; readonly expiraEm: number }
    | null
    | undefined;
}

/** Chamada por quem ESCREVE a configuração (a tela da instalação). */
export function invalidarConfigDoCadastroIncorporado(): void {
  globalThis.__memoDaConfigDoCadastroIncorporado = null;
}

async function linhaDoBanco(): Promise<LinhaDoCadastroIncorporado | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.from("platform_meta_app").select("app_id").eq("id", 1).maybeSingle();
    // Clone sem a 0984 devolve 42703 aqui: o `.env` assume.
    const appId = error || !data ? null : (data as { app_id: string | null }).app_id;
    const { data: cfg, error: erroDoConfig } = await admin
      .from("platform_meta_app")
      .select("whatsapp_config_id")
      .eq("id", 1)
      .maybeSingle();
    // 42703 = clone sem a 1014; qualquer outro erro também cai no `.env`.
    const configId = erroDoConfig || !cfg ? null : (cfg as { whatsapp_config_id: string | null }).whatsapp_config_id;
    return { app_id: appId, whatsapp_config_id: configId };
  } catch (err) {
    logger.warn("[cadastro-incorporado.config] leitura do banco falhou; vale o .env", {
      error: err instanceof Error ? err.name : "desconhecido",
    });
    return null;
  }
}

/** A configuração em vigor, ou `null` sem os três valores. Nunca lança. */
export async function configDoCadastroIncorporado(): Promise<ConfigDoCadastroIncorporado | null> {
  const memo = globalThis.__memoDaConfigDoCadastroIncorporado;
  if (memo && memo.expiraEm > Date.now()) return memo.valor;
  let appSecret: string | null = null;
  try {
    appSecret = (await appDaMeta()).appSecret;
  } catch {
    // appDaMeta não lança; o catch é cinto para a promessa de "nunca lança".
  }
  const valor = resolverConfigDoCadastroIncorporado(await linhaDoBanco(), appSecret);
  globalThis.__memoDaConfigDoCadastroIncorporado = { valor, expiraEm: Date.now() + TTL_MS };
  return valor;
}
