/**
 * Extrator de atribuição de anúncio da mensagem que chega pela UAZAPI.
 *
 * O anúncio "Clique para o WhatsApp" vem embutido na PRÓPRIA mensagem, em
 * `content.contextInfo.externalAdReply`, na grafia do whatsmeow (`sourceID`,
 * `sourceURL`, `thumbnailURL`). Nomear o provider aqui é legítimo (é a pasta do
 * canal); fora dela o `pnpm lint:channels` reprova. O formato agnóstico e a
 * gravação estão em `lib/leads/atribuicao-de-anuncio.ts`.
 */
import type { AtribuicaoDeAnuncio } from "@/lib/leads/atribuicao-de-anuncio";
import { obj, str, urlSegura } from "@/lib/leads/atribuicao-de-anuncio";

export function extrairAtribuicaoUazapi(conteudo: unknown): AtribuicaoDeAnuncio | null {
  const contextInfo = obj(obj(conteudo)?.contextInfo);
  const ad = obj(contextInfo?.externalAdReply) ?? obj(contextInfo?.externalAdReplyInfo);
  if (!ad) return null;

  // Post ORGÂNICO compartilhado não é anúncio pago: carimbá-lo como `meta_ads`
  // seria irreversível, porque a atribuição do contato só grava no primeiro toque.
  const tipo = str(ad.sourceType) ?? str(ad.source_type);
  if (tipo && tipo !== "ad") return null;

  // O clique é `ctwaClid`; o anúncio é `sourceID`. Quem traz os dois não perde um.
  const sourceId = str(ad.ctwaClid) ?? str(ad.ctwa_clid);
  const adId = str(ad.sourceID) ?? str(ad.sourceId) ?? str(ad.source_id);
  const titulo = str(ad.title);
  const sourceUrl = urlSegura(ad.sourceURL ?? ad.sourceUrl);
  if (!sourceId && !adId && !titulo && !sourceUrl) return null;

  // A miniatura em base64 (`thumbnail`) pesa dezenas de KB: fica fora da prova crua.
  const { thumbnail: _miniaturaPesada, ...bruto } = ad;

  return {
    plataforma: "meta_ads",
    sourceId,
    adId,
    titulo,
    corpo: str(ad.body),
    sourceUrl,
    miniatura: urlSegura(ad.thumbnailURL ?? ad.thumbnailUrl ?? ad.thumbnail_url),
    bruto,
  };
}
