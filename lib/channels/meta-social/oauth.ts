/**
 * Conversa com a Meta do canal social oficial: URLs de consentimento, trocas
 * de código e de token, renovação, conta, Páginas, assinatura do webhook,
 * perfil do remetente e envio.
 *
 * Regras de todo este arquivo:
 *  - Timeout em toda chamada (`AbortSignal.timeout`): uma Graph lenta não pode
 *    segurar o callback do navegador nem o worker.
 *  - Token NUNCA vai para log nem para mensagem de erro. `ErroDaMeta` carrega
 *    só o status HTTP, o código da Meta e um trecho da mensagem DELA.
 *  - Token em header (`Authorization: Bearer`) sempre que o endpoint aceita.
 *  - `client_secret` NUNCA em query string: as trocas de código do Instagram
 *    (login unificado) e do Messenger e a `fb_exchange_token` vão por POST com
 *    corpo `application/x-www-form-urlencoded` ao `/oauth/access_token` da
 *    Graph (a doc do login unificado mostra GET; o endpoint aceita POST, que é
 *    o que o Messenger já usa).
 *  - Tudo em `graph.facebook.com`: o token do Instagram pelo login unificado
 *    (SUAT) não funciona em `graph.instagram.com`
 *    (https://developers.facebook.com/documentation/instagram-platform/webhooks/setup).
 *  - Falha de rede não vaza a URL: da exceção só vai o NOME do erro.
 */
import {
  CAMPOS_DO_WEBHOOK_INSTAGRAM,
  CAMPOS_DO_WEBHOOK_MESSENGER,
  ESCOPOS_MESSENGER,
  HOST_AUTORIZACAO_FACEBOOK,
  HOST_GRAPH_FACEBOOK,
  VERSAO_DA_GRAPH_SOCIAL,
  type PlataformaMetaSocial,
} from "./constantes";
import type { AppDoLoginUnificado, AppOAuth } from "./config";

const TIMEOUT_MS = 15_000;

export class ErroDaMeta extends Error {
  constructor(
    readonly etapa: string,
    readonly status: number | null,
    readonly codigoDaMeta: number | null,
    detalhe: string,
  ) {
    super(`${etapa}: ${detalhe}`.slice(0, 300));
    this.name = "ErroDaMeta";
  }
}

/** A base de toda chamada do canal (os dois lados falam com `graph.facebook.com`). */
const GRAPH = `${HOST_GRAPH_FACEBOOK}/${VERSAO_DA_GRAPH_SOCIAL}`;

function leErro(corpo: unknown): { codigo: number | null; mensagem: string } {
  const o = (corpo && typeof corpo === "object" ? corpo : {}) as Record<string, unknown>;
  const e = (o.error && typeof o.error === "object" ? o.error : o) as Record<string, unknown>;
  const codigo = typeof e.code === "number" ? e.code : null;
  const mensagem =
    typeof e.message === "string"
      ? e.message
      : typeof o.error_message === "string"
        ? o.error_message
        : "resposta sem detalhe";
  return { codigo, mensagem: mensagem.slice(0, 200) };
}

/** Uma chamada à Meta. Devolve o JSON ou lança `ErroDaMeta`. */
export async function chamarMeta(
  etapa: string,
  url: string,
  init: { method?: string; token?: string; json?: unknown; form?: Record<string, string> } = {},
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  let resposta: Response;
  try {
    resposta = await fetcher(url, {
      method: init.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ErroDaMeta(etapa, null, null, err instanceof Error ? err.name : "rede");
  }
  const corpo: unknown = await resposta.json().catch(() => null);
  if (!resposta.ok) {
    const { codigo, mensagem } = leErro(corpo);
    throw new ErroDaMeta(etapa, resposta.status, codigo, mensagem);
  }
  if (!corpo || typeof corpo !== "object") {
    throw new ErroDaMeta(etapa, resposta.status, null, "resposta não é JSON");
  }
  return corpo as Record<string, unknown>;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;

// ─── Consentimento ─────────────────────────────────────────────────────────

/**
 * Instagram: login unificado — `www.facebook.com/dialog/oauth` com o
 * `config_id` da configuração (as permissões são as DELA; sem `scope`) e
 * `override_default_response_type=true`, para o `response_type=code` valer
 * sobre o padrão da configuração.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started
 * https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business
 *
 * `display=popup` e `prompt=login` (que o painel acrescenta ao link gerado) são
 * opcionais e ficam de fora: o Conectar é navegação de página inteira, não
 * janela; e `prompt=login` obrigaria a digitar a senha do Facebook a cada
 * conexão, mesmo com a sessão certa aberta.
 */
export function urlDeConsentimento(
  plataforma: PlataformaMetaSocial,
  app: AppOAuth | AppDoLoginUnificado,
  redirectUri: string,
  state: string,
): string {
  if (plataforma === "instagram") {
    if (!("configId" in app) || !app.configId) throw new Error("config_id do login unificado ausente");
    const u = new URL("/dialog/oauth", HOST_AUTORIZACAO_FACEBOOK);
    u.searchParams.set("client_id", app.appId);
    u.searchParams.set("config_id", app.configId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("override_default_response_type", "true");
    u.searchParams.set("state", state);
    return u.toString();
  }
  const u = new URL(`/${VERSAO_DA_GRAPH_SOCIAL}/dialog/oauth`, HOST_AUTORIZACAO_FACEBOOK);
  u.searchParams.set("client_id", app.appId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", ESCOPOS_MESSENGER.join(","));
  return u.toString();
}

// ─── Instagram (login unificado) ───────────────────────────────────────────

export interface TokenComValidade {
  token: string;
  /** Segundos até vencer; null = sem vencimento declarado. */
  expiraEmSegundos: number | null;
}

function lerTokenComValidade(etapa: string, r: Record<string, unknown>): TokenComValidade {
  const token = str(r.access_token);
  if (!token) throw new ErroDaMeta(etapa, 200, null, "sem access_token");
  const exp = typeof r.expires_in === "number" ? r.expires_in : Number(r.expires_in);
  return { token, expiraEmSegundos: Number.isFinite(exp) && exp > 0 ? exp : null };
}

/**
 * Código → token de usuário do sistema de integração empresarial (SUAT), com o
 * id e a chave do APP DA META. A validade é a da configuração do painel (o
 * padrão é não vencer); a doc não descreve os campos da resposta, então
 * `expires_in` é lido SE vier — NÃO CONFIRMADO NA DOC que ele vem quando a
 * configuração define validade.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication
 */
export async function trocarCodigoLoginUnificado(
  app: AppOAuth,
  code: string,
  redirectUri: string,
  fetcher?: typeof fetch,
): Promise<TokenComValidade> {
  return lerTokenComValidade(
    "instagram_troca_de_codigo",
    await chamarMeta(
      "instagram_troca_de_codigo",
      `${GRAPH}/oauth/access_token`,
      { form: { client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code } },
      fetcher,
    ),
  );
}

export interface UsuarioDoSistema {
  /** O portfólio de negócios do cliente. */
  clientBusinessId: string | null;
  /**
   * O `id` app-scoped do /me. Com SUAT o /me é o USUÁRIO DO SISTEMA de
   * integração, não a pessoa que fez o login (doc do get-started).
   */
  id: string | null;
}

/** GET /me?fields=client_business_id,id — https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business */
export async function usuarioDoSistema(token: string, fetcher?: typeof fetch): Promise<UsuarioDoSistema> {
  const r = await chamarMeta("instagram_empresa", `${GRAPH}/me?fields=client_business_id,id`, { token }, fetcher);
  return { clientBusinessId: str(r.client_business_id), id: str(r.id) };
}

export interface ContaDaMeta {
  /** IG: id da conta profissional (IG_ID); Messenger: id da Página. É o `entry.id`. */
  id: string;
  usuario: string | null;
  nome: string | null;
}

/** Teto de páginas da listagem: 10 × 100 contas é muito além de qualquer portfólio real. */
const TETO_DE_PAGINAS = 10;

/**
 * As contas do Instagram concedidas no login (precisa de `instagram_basic`).
 * Paginado pelo cursor `after` — a URL de `paging.next` não é seguida, para o
 * token continuar só no header.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started
 */
export async function contasInstagramConcedidas(token: string, fetcher?: typeof fetch): Promise<ContaDaMeta[]> {
  const contas: ContaDaMeta[] = [];
  const vistas = new Set<string>();
  let depois: string | null = null;
  for (let i = 0; i < TETO_DE_PAGINAS; i += 1) {
    const u = new URL(`${GRAPH}/me/assigned_instagram_accounts`);
    u.searchParams.set("fields", "id,username");
    u.searchParams.set("limit", "100");
    if (depois) u.searchParams.set("after", depois);
    const r = await chamarMeta("instagram_contas", u.toString(), { token }, fetcher);
    for (const c of Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : []) {
      const id = str(c.id);
      if (!id || vistas.has(id)) continue;
      vistas.add(id);
      contas.push({ id, usuario: str(c.username), nome: null });
    }
    const paging = (r.paging && typeof r.paging === "object" ? r.paging : {}) as Record<string, unknown>;
    const cursores = (paging.cursors && typeof paging.cursors === "object" ? paging.cursors : {}) as Record<string, unknown>;
    depois = paging.next ? str(cursores.after) : null;
    if (!depois) break;
  }
  return contas;
}

// ─── Messenger ─────────────────────────────────────────────────────────────

export async function trocarCodigoMessenger(
  app: AppOAuth,
  code: string,
  redirectUri: string,
  fetcher?: typeof fetch,
): Promise<string> {
  return lerTokenComValidade(
    "messenger_troca_de_codigo",
    await chamarMeta(
      "messenger_troca_de_codigo",
      `${HOST_GRAPH_FACEBOOK}/${VERSAO_DA_GRAPH_SOCIAL}/oauth/access_token`,
      {
        form: {
          client_id: app.appId,
          client_secret: app.appSecret,
          redirect_uri: redirectUri,
          code,
        },
      },
      fetcher,
    ),
  ).token;
}

/** Token de usuário curto → longo. Token de Página derivado de token longo não expira. */
export async function tokenLongoMessenger(
  app: AppOAuth,
  tokenCurto: string,
  fetcher?: typeof fetch,
): Promise<string> {
  return lerTokenComValidade(
    "messenger_token_longo",
    await chamarMeta(
      "messenger_token_longo",
      `${HOST_GRAPH_FACEBOOK}/${VERSAO_DA_GRAPH_SOCIAL}/oauth/access_token`,
      {
        form: {
          grant_type: "fb_exchange_token",
          client_id: app.appId,
          client_secret: app.appSecret,
          fb_exchange_token: tokenCurto,
        },
      },
      fetcher,
    ),
  ).token;
}

/**
 * O id (com escopo do app) da pessoa do Facebook que autorizou — o mesmo
 * `user_id` que o `signed_request` da exclusão de dados traz. `null` em falha:
 * não ter o id não impede conectar, só deixa a exclusão casar pela conta.
 */
export async function usuarioDoFacebook(tokenDeUsuario: string, fetcher?: typeof fetch): Promise<string | null> {
  try {
    const r = await chamarMeta(
      "messenger_usuario",
      `${HOST_GRAPH_FACEBOOK}/${VERSAO_DA_GRAPH_SOCIAL}/me?fields=id`,
      { token: tokenDeUsuario },
      fetcher,
    );
    return str(r.id);
  } catch {
    return null;
  }
}

export interface PaginaConcedida extends ContaDaMeta {
  token: string;
}

/** As Páginas que a pessoa concedeu no diálogo, cada uma com o seu token. */
export async function paginasMessenger(
  tokenDeUsuario: string,
  fetcher?: typeof fetch,
): Promise<PaginaConcedida[]> {
  const r = await chamarMeta(
    "messenger_paginas",
    `${HOST_GRAPH_FACEBOOK}/${VERSAO_DA_GRAPH_SOCIAL}/me/accounts?fields=id,name,access_token&limit=100`,
    { token: tokenDeUsuario },
    fetcher,
  );
  const lista = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
  return lista.flatMap((p) => {
    const id = str(p.id);
    const token = str(p.access_token);
    return id && token ? [{ id, token, usuario: null, nome: str(p.name) }] : [];
  });
}

// ─── Assinatura do webhook, por conta ──────────────────────────────────────

/**
 * Assina a conta nos webhooks do app.
 *  - Instagram (login unificado): POST graph.facebook.com/<IG_ID>/subscribed_apps
 *    com `subscribed_fields` no corpo do formulário e o SUAT.
 *    https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
 *  - Messenger: POST /<PAGE_ID>/subscribed_apps com o token da Página.
 */
export async function assinarWebhookDaConta(
  plataforma: PlataformaMetaSocial,
  contaId: string,
  token: string,
  fetcher?: typeof fetch,
): Promise<void> {
  const base = `${GRAPH}/${encodeURIComponent(contaId)}/subscribed_apps`;
  const r = await chamarMeta(
    `${plataforma}_assinatura`,
    plataforma === "instagram" ? base : `${base}?subscribed_fields=${CAMPOS_DO_WEBHOOK_MESSENGER}`,
    plataforma === "instagram"
      ? { token, form: { subscribed_fields: CAMPOS_DO_WEBHOOK_INSTAGRAM } }
      : { method: "POST", token },
    fetcher,
  );
  if (r.success !== true) throw new ErroDaMeta(`${plataforma}_assinatura`, 200, null, "success != true");
}

export async function desassinarWebhookDaConta(
  plataforma: PlataformaMetaSocial,
  contaId: string,
  token: string,
  fetcher?: typeof fetch,
): Promise<void> {
  await chamarMeta(
    `${plataforma}_desassinatura`,
    `${GRAPH}/${encodeURIComponent(contaId)}/subscribed_apps`,
    { method: "DELETE", token },
    fetcher,
  );
}

// ─── Perfil do remetente (best-effort) ─────────────────────────────────────

/**
 * Nome de quem escreveu. `null` em qualquer falha — nunca bloqueia a ingestão.
 * Instagram: GET /<IGSID>?fields=name,username,profile_pic. A página do perfil
 * só documenta o host `graph.instagram.com` (login do Instagram); no login
 * unificado toda chamada vai a `graph.facebook.com` — NÃO CONFIRMADO NA DOC
 * para este endpoint especificamente.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile
 */
export async function perfilDoRemetente(
  plataforma: PlataformaMetaSocial,
  clienteId: string,
  token: string,
  fetcher?: typeof fetch,
): Promise<{ nome: string | null; usuario: string | null } | null> {
  const campos = plataforma === "instagram" ? "name,username,profile_pic" : "first_name,last_name,profile_pic";
  try {
    const r = await chamarMeta(
      `${plataforma}_perfil`,
      `${GRAPH}/${encodeURIComponent(clienteId)}?fields=${campos}`,
      { token },
      fetcher,
    );
    if (plataforma === "instagram") {
      const usuario = str(r.username);
      return { nome: str(r.name) ?? (usuario ? `@${usuario}` : null), usuario };
    }
    const nome = [str(r.first_name), str(r.last_name)].filter(Boolean).join(" ");
    return { nome: nome || null, usuario: null };
  } catch {
    return null;
  }
}

// ─── Envio ─────────────────────────────────────────────────────────────────

export interface RequisicaoDeEnvio {
  url: string;
  corpo: Record<string, unknown>;
}

/** Divide o texto em pedaços de até `teto` bytes UTF-8, de preferência no espaço. */
export function dividirTexto(texto: string, teto: number): string[] {
  const pedacos: string[] = [];
  let resto = texto.trim();
  while (Buffer.byteLength(resto, "utf8") > teto) {
    let corte = 0;
    let bytes = 0;
    let ultimoEspaco = -1;
    for (const ch of resto) {
      const b = Buffer.byteLength(ch, "utf8");
      if (bytes + b > teto) break;
      bytes += b;
      corte += ch.length;
      if (/\s/.test(ch)) ultimoEspaco = corte;
    }
    const fim = ultimoEspaco > 0 ? ultimoEspaco : corte;
    pedacos.push(resto.slice(0, fim).trimEnd());
    resto = resto.slice(fim).trimStart();
  }
  if (resto.length > 0) pedacos.push(resto);
  return pedacos;
}

/**
 * As requisições de um envio, sem token. Instagram: POST
 * graph.facebook.com/<IG_ID>/messages com o SUAT. A página de envio só
 * documenta `graph.instagram.com` (login do Instagram); a do login unificado
 * diz que as chamadas vão a `graph.facebook.com/<IG_ID>` — o caminho
 * `/messages` nesse host é NÃO CONFIRMADO NA DOC.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication
 *
 * As requisições de um envio, sem token. O token vai no header na hora de
 * executar — nunca na URL, que um proxy ou log poderia guardar.
 */
export function montarEnvios(input: {
  plataforma: PlataformaMetaSocial;
  contaId: string;
  destinatario: string;
  texto?: string | null;
  imagemUrl?: string | null;
  teto: number;
}): RequisicaoDeEnvio[] {
  const url = `${GRAPH}/${encodeURIComponent(input.contaId)}/messages`;
  const base: Record<string, unknown> = {
    recipient: { id: input.destinatario },
    ...(input.plataforma === "messenger" ? { messaging_type: "RESPONSE" } : {}),
  };
  const envios: RequisicaoDeEnvio[] = [];
  if (input.imagemUrl) {
    envios.push({
      url,
      corpo: { ...base, message: { attachment: { type: "image", payload: { url: input.imagemUrl } } } },
    });
  }
  for (const pedaco of dividirTexto(input.texto ?? "", input.teto)) {
    envios.push({ url, corpo: { ...base, message: { text: pedaco } } });
  }
  return envios;
}

/** Executa um envio e devolve o `message_id` (mid). */
export async function enviar(
  requisicao: RequisicaoDeEnvio,
  token: string,
  fetcher?: typeof fetch,
): Promise<string> {
  const r = await chamarMeta("envio", requisicao.url, { token, json: requisicao.corpo }, fetcher);
  const mid = str(r.message_id);
  if (!mid) throw new ErroDaMeta("envio", 200, null, "sem message_id");
  return mid;
}
