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
 *    As exceções são os endpoints de troca/renovação de token, que a Meta só
 *    aceita por query string; eles são chamados de servidor para servidor e a
 *    URL nunca é registrada.
 */
import {
  CAMPOS_DO_WEBHOOK_INSTAGRAM,
  CAMPOS_DO_WEBHOOK_MESSENGER,
  ESCOPOS_INSTAGRAM,
  ESCOPOS_MESSENGER,
  HOST_AUTORIZACAO_FACEBOOK,
  HOST_AUTORIZACAO_INSTAGRAM,
  HOST_GRAPH_FACEBOOK,
  HOST_GRAPH_INSTAGRAM,
  HOST_OAUTH_INSTAGRAM,
  VERSAO_DA_GRAPH_SOCIAL,
  type PlataformaMetaSocial,
} from "./constantes";
import type { AppOAuth } from "./config";

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

export function hostDaGraph(plataforma: PlataformaMetaSocial): string {
  return plataforma === "instagram" ? HOST_GRAPH_INSTAGRAM : HOST_GRAPH_FACEBOOK;
}

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

export function urlDeConsentimento(
  plataforma: PlataformaMetaSocial,
  app: AppOAuth,
  redirectUri: string,
  state: string,
): string {
  if (plataforma === "instagram") {
    const u = new URL("/oauth/authorize", HOST_AUTORIZACAO_INSTAGRAM);
    u.searchParams.set("client_id", app.appId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", ESCOPOS_INSTAGRAM.join(","));
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

// ─── Instagram ─────────────────────────────────────────────────────────────

export interface TokenComValidade {
  token: string;
  /** Segundos até vencer; null = sem vencimento declarado. */
  expiraEmSegundos: number | null;
}

/** Código (1h, uso único) → token CURTO. */
export async function trocarCodigoInstagram(
  app: AppOAuth,
  code: string,
  redirectUri: string,
  fetcher?: typeof fetch,
): Promise<string> {
  const r = await chamarMeta(
    "instagram_troca_de_codigo",
    `${HOST_OAUTH_INSTAGRAM}/oauth/access_token`,
    {
      form: {
        client_id: app.appId,
        client_secret: app.appSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      },
    },
    fetcher,
  );
  // Formato antigo: {access_token, user_id}; novo: {data:[{access_token, ...}]}.
  const dado = Array.isArray(r.data) ? (r.data[0] as Record<string, unknown> | undefined) : r;
  const token = str(dado?.access_token);
  if (!token) throw new ErroDaMeta("instagram_troca_de_codigo", 200, null, "sem access_token");
  return token;
}

function lerTokenComValidade(etapa: string, r: Record<string, unknown>): TokenComValidade {
  const token = str(r.access_token);
  if (!token) throw new ErroDaMeta(etapa, 200, null, "sem access_token");
  const exp = typeof r.expires_in === "number" ? r.expires_in : Number(r.expires_in);
  return { token, expiraEmSegundos: Number.isFinite(exp) && exp > 0 ? exp : null };
}

/** Token curto → token LONGO (60 dias). */
export async function tokenLongoInstagram(
  app: AppOAuth,
  tokenCurto: string,
  fetcher?: typeof fetch,
): Promise<TokenComValidade> {
  const u = new URL("/access_token", HOST_GRAPH_INSTAGRAM);
  u.searchParams.set("grant_type", "ig_exchange_token");
  u.searchParams.set("client_secret", app.appSecret);
  u.searchParams.set("access_token", tokenCurto);
  return lerTokenComValidade(
    "instagram_token_longo",
    await chamarMeta("instagram_token_longo", u.toString(), {}, fetcher),
  );
}

/** Renova um token longo (precisa ter ≥24h e não estar vencido). */
export async function renovarTokenInstagram(
  token: string,
  fetcher?: typeof fetch,
): Promise<TokenComValidade> {
  const u = new URL("/refresh_access_token", HOST_GRAPH_INSTAGRAM);
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", token);
  return lerTokenComValidade(
    "instagram_renovacao",
    await chamarMeta("instagram_renovacao", u.toString(), {}, fetcher),
  );
}

export interface ContaDaMeta {
  /** IG: `user_id` da conta profissional; Messenger: id da Página. É o `entry.id`. */
  id: string;
  usuario: string | null;
  nome: string | null;
}

export async function contaInstagram(token: string, fetcher?: typeof fetch): Promise<ContaDaMeta> {
  const r = await chamarMeta(
    "instagram_conta",
    `${HOST_GRAPH_INSTAGRAM}/${VERSAO_DA_GRAPH_SOCIAL}/me?fields=user_id,username,name`,
    { token },
    fetcher,
  );
  const id = str(r.user_id);
  if (!id) throw new ErroDaMeta("instagram_conta", 200, null, "sem user_id");
  return { id, usuario: str(r.username), nome: str(r.name) };
}

// ─── Messenger ─────────────────────────────────────────────────────────────

export async function trocarCodigoMessenger(
  app: AppOAuth,
  code: string,
  redirectUri: string,
  fetcher?: typeof fetch,
): Promise<string> {
  const u = new URL(`/${VERSAO_DA_GRAPH_SOCIAL}/oauth/access_token`, HOST_GRAPH_FACEBOOK);
  u.searchParams.set("client_id", app.appId);
  u.searchParams.set("client_secret", app.appSecret);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code", code);
  return lerTokenComValidade(
    "messenger_troca_de_codigo",
    await chamarMeta("messenger_troca_de_codigo", u.toString(), {}, fetcher),
  ).token;
}

/** Token de usuário curto → longo. Token de Página derivado de token longo não expira. */
export async function tokenLongoMessenger(
  app: AppOAuth,
  tokenCurto: string,
  fetcher?: typeof fetch,
): Promise<string> {
  const u = new URL(`/${VERSAO_DA_GRAPH_SOCIAL}/oauth/access_token`, HOST_GRAPH_FACEBOOK);
  u.searchParams.set("grant_type", "fb_exchange_token");
  u.searchParams.set("client_id", app.appId);
  u.searchParams.set("client_secret", app.appSecret);
  u.searchParams.set("fb_exchange_token", tokenCurto);
  return lerTokenComValidade(
    "messenger_token_longo",
    await chamarMeta("messenger_token_longo", u.toString(), {}, fetcher),
  ).token;
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

function urlDaAssinatura(plataforma: PlataformaMetaSocial, contaId: string): string {
  const campos =
    plataforma === "instagram" ? CAMPOS_DO_WEBHOOK_INSTAGRAM : CAMPOS_DO_WEBHOOK_MESSENGER;
  return `${hostDaGraph(plataforma)}/${VERSAO_DA_GRAPH_SOCIAL}/${encodeURIComponent(contaId)}/subscribed_apps?subscribed_fields=${campos}`;
}

export async function assinarWebhookDaConta(
  plataforma: PlataformaMetaSocial,
  contaId: string,
  token: string,
  fetcher?: typeof fetch,
): Promise<void> {
  const r = await chamarMeta(
    `${plataforma}_assinatura`,
    urlDaAssinatura(plataforma, contaId),
    { method: "POST", token },
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
    `${hostDaGraph(plataforma)}/${VERSAO_DA_GRAPH_SOCIAL}/${encodeURIComponent(contaId)}/subscribed_apps`,
    { method: "DELETE", token },
    fetcher,
  );
}

// ─── Perfil do remetente (best-effort) ─────────────────────────────────────

/** Nome de quem escreveu. `null` em qualquer falha — nunca bloqueia a ingestão. */
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
      `${hostDaGraph(plataforma)}/${VERSAO_DA_GRAPH_SOCIAL}/${encodeURIComponent(clienteId)}?fields=${campos}`,
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
  const url = `${hostDaGraph(input.plataforma)}/${VERSAO_DA_GRAPH_SOCIAL}/${encodeURIComponent(input.contaId)}/messages`;
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
