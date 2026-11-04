/**
 * Os posts de uma conta do Instagram conectada pelo canal oficial, para quem
 * escolhe "em qual post" uma automação de comentário vale: a lista dos
 * recentes e a resolução de um link colado (`instagram.com/p/<código>`) no id
 * da mídia.
 *
 * A organização é o parâmetro que quem chama resolveu de fonte confiável
 * (sessão do usuário); a sessão do canal é lida FILTRADA por ela, e sessão de
 * outra organização, arquivada, de Messenger ou sem token é
 * `conta_indisponivel` — a Meta nem é chamada. O token vai só no header.
 *
 * GET /<IG_USER_ID>/media lista as mídias da conta (mais recentes primeiro),
 * paginado por cursor.
 * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { HOST_GRAPH_FACEBOOK, VERSAO_DA_GRAPH_SOCIAL } from "./constantes";
import { credencialDaSessao } from "./credencial";
import { ErroDaMeta, chamarMeta } from "./oauth";

const GRAPH = `${HOST_GRAPH_FACEBOOK}/${VERSAO_DA_GRAPH_SOCIAL}`;

export const LIMITE_PADRAO_DE_POSTS = 24;
export const LIMITE_MAXIMO_DE_POSTS = 50;
/** Teto da legenda devolvida (caracteres). */
export const TETO_DA_LEGENDA_CURTA = 120;
/** Páginas de 50 que a resolução por link percorre antes de desistir. */
export const PAGINAS_DA_BUSCA_POR_LINK = 4;
const POR_PAGINA_NA_BUSCA = 50;

const CAMPOS_DA_LISTA = "id,permalink,caption,media_type,media_product_type,thumbnail_url,media_url,timestamp";

export interface PostDoInstagram {
  media_id: string;
  permalink: string | null;
  /** A legenda em até 120 caracteres; `null` sem legenda. */
  legenda_curta: string | null;
  /** `thumbnail_url` para vídeo (ou `media_url`, se faltar); `media_url` para o resto. */
  miniatura: string | null;
  /** `REELS` quando `media_product_type` é REELS; senão o `media_type` (IMAGE, VIDEO, CAROUSEL_ALBUM). */
  tipo: string | null;
  /** `timestamp` da Meta (ISO-8601). */
  publicado_em: string | null;
}

export type ErroDosPosts = "conta_indisponivel" | "meta_falhou";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;

function legendaCurta(caption: string | null): string | null {
  if (!caption) return null;
  const t = caption.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const chars = Array.from(t);
  return chars.length <= TETO_DA_LEGENDA_CURTA ? t : `${chars.slice(0, TETO_DA_LEGENDA_CURTA - 1).join("")}…`;
}

function lerPost(m: Record<string, unknown>): PostDoInstagram | null {
  const id = str(m.id);
  if (!id) return null;
  const mediaType = str(m.media_type);
  const produto = str(m.media_product_type);
  return {
    media_id: id,
    permalink: str(m.permalink),
    legenda_curta: legendaCurta(str(m.caption)),
    // `thumbnail_url` só vem em VIDEO; `media_url` pode faltar em vídeo com áudio licenciado.
    miniatura: mediaType === "VIDEO" ? (str(m.thumbnail_url) ?? str(m.media_url)) : str(m.media_url),
    tipo: produto === "REELS" ? "REELS" : mediaType,
    publicado_em: str(m.timestamp),
  };
}

function cursorSeguinte(r: Record<string, unknown>): string | null {
  const paging = (r.paging && typeof r.paging === "object" ? r.paging : {}) as Record<string, unknown>;
  const cursores = (paging.cursors && typeof paging.cursors === "object" ? paging.cursors : {}) as Record<string, unknown>;
  return paging.next ? str(cursores.after) : null;
}

function limiteValido(limite: number | undefined): number {
  if (limite === undefined || !Number.isFinite(limite)) return LIMITE_PADRAO_DE_POSTS;
  return Math.min(LIMITE_MAXIMO_DE_POSTS, Math.max(1, Math.trunc(limite)));
}

/** Os posts mais recentes da conta (padrão 24, no máximo 50). */
export async function listarPostsRecentes(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; limite?: number },
  fetcher?: typeof fetch,
): Promise<{ posts: PostDoInstagram[] } | { erro: ErroDosPosts }> {
  const cred = await credencialDaSessao(admin, input.organizationId, input.channelSessionId);
  if (!cred) return { erro: "conta_indisponivel" };
  const u = new URL(`${GRAPH}/${encodeURIComponent(cred.contaId)}/media`);
  u.searchParams.set("fields", CAMPOS_DA_LISTA);
  u.searchParams.set("limit", String(limiteValido(input.limite)));
  let r: Record<string, unknown>;
  try {
    r = await chamarMeta("instagram_posts", u.toString(), { token: cred.token }, fetcher);
  } catch (err) {
    if (err instanceof ErroDaMeta) return { erro: "meta_falhou" };
    throw err;
  }
  const posts: PostDoInstagram[] = [];
  for (const m of Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : []) {
    const p = lerPost(m);
    if (p) posts.push(p);
  }
  return { posts };
}

const TIPOS_DE_LINK: ReadonlySet<string> = new Set(["p", "reel", "reels", "tv"]);
const CODIGO = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * O código do post num link do Instagram: `instagram.com/p/<código>`,
 * `/reel/`, `/reels/` ou `/tv/`, com ou sem `www`, com ou sem `https://`,
 * query e barra final. Qualquer outra coisa é `null`.
 */
export function codigoDoLink(link: string): string | null {
  const t = link.trim();
  if (!t || t.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (host !== "instagram.com" && host !== "www.instagram.com") return null;
  const partes = u.pathname.split("/").filter(Boolean);
  if (partes.length !== 2) return null;
  const [tipo, codigo] = partes as [string, string];
  if (!TIPOS_DE_LINK.has(tipo.toLowerCase()) || !CODIGO.test(codigo)) return null;
  return codigo;
}

/**
 * O id da mídia de um link de post DESTA conta. Compara o código do link com o
 * `shortcode` e com o código do `permalink` de cada mídia, até 4 páginas de 50
 * (as 200 mais recentes). A paginação por cursor `after` é a padrão da Graph;
 * a página da doc do endpoint só fala em `since`/`until` (NÃO CONFIRMADO NA DOC).
 */
export async function resolverPostPorLink(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; link: string },
  fetcher?: typeof fetch,
): Promise<{ media_id: string } | { erro: "link_invalido" | "post_nao_encontrado" | ErroDosPosts }> {
  const alvo = codigoDoLink(input.link);
  if (!alvo) return { erro: "link_invalido" };
  const cred = await credencialDaSessao(admin, input.organizationId, input.channelSessionId);
  if (!cred) return { erro: "conta_indisponivel" };
  let depois: string | null = null;
  for (let i = 0; i < PAGINAS_DA_BUSCA_POR_LINK; i += 1) {
    const u = new URL(`${GRAPH}/${encodeURIComponent(cred.contaId)}/media`);
    u.searchParams.set("fields", "id,permalink,shortcode");
    u.searchParams.set("limit", String(POR_PAGINA_NA_BUSCA));
    if (depois) u.searchParams.set("after", depois);
    let r: Record<string, unknown>;
    try {
      r = await chamarMeta("instagram_post_por_link", u.toString(), { token: cred.token }, fetcher);
    } catch (err) {
      if (err instanceof ErroDaMeta) return { erro: "meta_falhou" };
      throw err;
    }
    for (const m of Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : []) {
      const id = str(m.id);
      if (!id) continue;
      // `shortcode` é o código do link; o `permalink` é a conferência quando ele não vem.
      const permalink = str(m.permalink);
      if (str(m.shortcode) === alvo || (permalink && codigoDoLink(permalink) === alvo)) return { media_id: id };
    }
    depois = cursorSeguinte(r);
    if (!depois) break;
  }
  return { erro: "post_nao_encontrado" };
}
