/**
 * Os DADOS DO ANÚNCIO que uma automação lê do contato — `{{contact.anuncio.*}}`.
 *
 * O anúncio de primeiro toque já mora em `contacts.source_metadata`
 * (`estamparAtribuicaoDoContato`, `lib/leads/atribuicao-de-anuncio.ts`); aqui
 * só se PROJETA esse jsonb nas seis variáveis que o fluxo oferece. Nenhum dado
 * novo é gravado e nenhuma coluna nasce.
 *
 *   {{contact.anuncio.ctwa_clid}}   o clique que abriu a conversa (`ad_source_id`)
 *   {{contact.anuncio.source_id}}   o ANÚNCIO (`ad_id`; `referral.source_id`)
 *   {{contact.anuncio.source_url}}  o link do anúncio (`ad_source_url`)
 *   {{contact.anuncio.headline}}    o título (`ad_title`)
 *   {{contact.anuncio.body}}        o texto (`ad_body`)
 *   {{contact.anuncio.media_type}}  `image`, `video`... (`ad_media_type`; contato
 *                                   carimbado antes lê do payload cru, `ad_raw`)
 *
 * Ausência é string VAZIA, nunca `undefined`: a variável sai em branco no texto
 * e um campo gravado por ela não recebe a palavra "undefined". `ctwa_clid` só
 * vale para clique-pro-WhatsApp: o clique capturado na página (`fbclid`/`gclid`
 * do formulário) tem outro formato e sai vazio aqui.
 */

export const CHAVES_DO_ANUNCIO = [
  "ctwa_clid",
  "source_id",
  "source_url",
  "headline",
  "body",
  "media_type",
] as const;
export type ChaveDoAnuncio = (typeof CHAVES_DO_ANUNCIO)[number];
export type AnuncioDoFluxo = Record<ChaveDoAnuncio, string>;

/** O prefixo das variáveis do anúncio no contexto do texto: `contact.anuncio.<chave>`. */
export const PREFIXO_DO_ANUNCIO = "contact.anuncio.";

export function anuncioVazio(): AnuncioDoFluxo {
  return { ctwa_clid: "", source_id: "", source_url: "", headline: "", body: "", media_type: "" };
}

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** `contacts.source_metadata` → as seis variáveis, todas string. Nunca lança. */
export function anuncioDoFluxo(sourceMetadata: unknown): AnuncioDoFluxo {
  const m = objeto(sourceMetadata);
  if (texto(m.ad_platform) === "") return anuncioVazio();
  const cru = objeto(m.ad_raw);
  const doSite = texto(m.ad_click_source) === "site";
  return {
    ctwa_clid: doSite || texto(m.ad_platform) !== "meta_ads" ? "" : texto(m.ad_source_id),
    source_id: texto(m.ad_id),
    source_url: texto(m.ad_source_url),
    headline: texto(m.ad_title),
    body: texto(m.ad_body),
    media_type: texto(m.ad_media_type) || texto(cru.media_type) || texto(cru.mediaType),
  };
}

/** O valor de `contact.anuncio.<chave>` num caminho de variável (`var:` do seletor), ou `undefined` quando o caminho não é do anúncio. */
export function chaveDoAnuncioNoCaminho(path: string): ChaveDoAnuncio | null {
  if (!path.startsWith(PREFIXO_DO_ANUNCIO)) return null;
  const chave = path.slice(PREFIXO_DO_ANUNCIO.length);
  return (CHAVES_DO_ANUNCIO as readonly string[]).includes(chave) ? (chave as ChaveDoAnuncio) : null;
}
