import { describe, expect, it } from "vitest";

import { extrairAtribuicaoUazapi } from "@/lib/channels/uazapi/atribuicao-de-anuncio";
import { lerEnvelopeUazapi } from "@/lib/channels/uazapi/envelope";
import { parseUazapiMensagem } from "@/lib/channels/uazapi/webhook";

/**
 * O anúncio "Clique para o WhatsApp" que chega pela UAZAPI.
 *
 * Medido em produção (25/11/2026): a instância entrega o anúncio em
 * `message.content.contextInfo.externalAdReply`, com a grafia do whatsmeow —
 * `sourceID`, `sourceURL`, `thumbnailURL` (maiúsculas), `ctwaClid`, `sourceApp`.
 * O CRM descartava tudo isso: `{{contact.anuncio.*}}` chegava vazio e a
 * automação de rastreamento concluía "não veio de anúncio".
 *
 * A forma abaixo é a do payload real; os valores de identificação são
 * inventados (nenhum dado de cliente no repositório).
 */

const AD_REPLY = {
  title: "Casa nova com renda garantida",
  body: "E se você pudesse comprar uma casa e já ter renda com ela?",
  mediaType: 2,
  thumbnailURL: "https://scontent.cdninstagram.com/v/t15/miniatura.jpg",
  mediaURL: "https://www.facebook.com/reel/1111111111/",
  thumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/" + "A".repeat(4000),
  sourceType: "ad",
  sourceID: "120250000000000001",
  sourceURL: "https://www.instagram.com/p/AbCdEf123/",
  containsAutoReply: false,
  renderLargerThumbnail: true,
  showAdAttribution: true,
  ctwaClid: "AfgCLIQUEinventado_0123456789abcdefghij",
  sourceApp: "instagram",
  greetingMessageBody: "Olá! Envie a mensagem abaixo para iniciar o seu atendimento.",
};

function conteudo(extra: Record<string, unknown> = {}) {
  return {
    text: "Olá! Vi o vídeo e quero saber mais.",
    contextInfo: {
      conversionSource: "FB_Ads",
      conversionData: "QWZqaW52ZW50YWRv",
      externalAdReply: AD_REPLY,
      entryPointConversionSource: "ctwa_ad",
      entryPointConversionApp: "instagram",
      ...extra,
    },
  };
}

describe("extrairAtribuicaoUazapi", () => {
  it("lê o anúncio na grafia da UAZAPI: clique, anúncio, título, texto, link e miniatura", () => {
    const a = extrairAtribuicaoUazapi(conteudo());
    expect(a).not.toBeNull();
    expect(a).toMatchObject({
      plataforma: "meta_ads",
      sourceId: AD_REPLY.ctwaClid,
      adId: AD_REPLY.sourceID,
      titulo: AD_REPLY.title,
      corpo: AD_REPLY.body,
      sourceUrl: AD_REPLY.sourceURL,
      miniatura: AD_REPLY.thumbnailURL,
    });
  });

  it("guarda a prova crua SEM a miniatura em base64 — ela pesa dezenas de KB em source_metadata", () => {
    const a = extrairAtribuicaoUazapi(conteudo())!;
    expect(a.bruto).not.toHaveProperty("thumbnail");
    expect(a.bruto).toMatchObject({ sourceID: AD_REPLY.sourceID, sourceApp: "instagram", ctwaClid: AD_REPLY.ctwaClid });
  });

  it("aceita também a grafia minúscula (sourceId/sourceUrl/thumbnailUrl)", () => {
    const { sourceID, sourceURL, thumbnailURL, ...resto } = AD_REPLY;
    const a = extrairAtribuicaoUazapi({
      contextInfo: { externalAdReply: { ...resto, sourceId: sourceID, sourceUrl: sourceURL, thumbnailUrl: thumbnailURL } },
    });
    expect(a).toMatchObject({ adId: sourceID, sourceUrl: sourceURL, miniatura: thumbnailURL });
  });

  it("post ORGÂNICO compartilhado não é anúncio pago", () => {
    expect(extrairAtribuicaoUazapi({ contextInfo: { externalAdReply: { ...AD_REPLY, sourceType: "post" } } })).toBeNull();
  });

  it("mensagem comum (texto puro, sem contextInfo, contextInfo sem anúncio) não inventa atribuição", () => {
    expect(extrairAtribuicaoUazapi("oi")).toBeNull();
    expect(extrairAtribuicaoUazapi(null)).toBeNull();
    expect(extrairAtribuicaoUazapi({ text: "oi" })).toBeNull();
    expect(extrairAtribuicaoUazapi({ contextInfo: { stanzaId: "X" } })).toBeNull();
  });

  it("anúncio sem nenhum identificador útil é ignorado", () => {
    expect(extrairAtribuicaoUazapi({ contextInfo: { externalAdReply: { sourceType: "ad", mediaType: 2 } } })).toBeNull();
  });

  it("link de anúncio que não é https não vira href na tela", () => {
    const a = extrairAtribuicaoUazapi({
      contextInfo: { externalAdReply: { ...AD_REPLY, sourceURL: "javascript:alert(1)", thumbnailURL: "data:image/png;base64,AA" } },
    })!;
    expect(a.sourceUrl).toBeNull();
    expect(a.miniatura).toBeNull();
    expect(a.adId).toBe(AD_REPLY.sourceID);
  });
});

describe("parseUazapiMensagem leva o anúncio adiante", () => {
  function lida(content: unknown, extra: Record<string, unknown> = {}) {
    const bruto = {
      EventType: "messages",
      BaseUrl: "https://empresa.uazapi.com",
      instanceName: "comercial",
      owner: "553599990000",
      token: "0a1b2c3d-aa11-4b2c-bbbb-a123b4c5d6e7",
      chat: { wa_chatid: "553591234567@s.whatsapp.net", wa_name: "Cliente Teste" },
      message: {
        messageid: "3EB0AAAA2222",
        chatid: "553591234567@s.whatsapp.net",
        isGroup: false,
        fromMe: false,
        wasSentByApi: false,
        messageType: "ExtendedTextMessage",
        messageTimestamp: 1_789_500_000_000,
        senderName: "Maria",
        text: "Olá! Vi o vídeo e quero saber mais.",
        content,
        ...extra,
      },
    };
    const leitura = lerEnvelopeUazapi(JSON.stringify(bruto));
    if (!leitura.ok) throw new Error("payload de teste fora do contrato");
    const r = parseUazapiMensagem(leitura.envelope);
    if (!r.ok) throw new Error(`não leu: ${r.motivo}`);
    return r.msg;
  }

  it("entrada que veio de anúncio carrega a atribuição na mensagem lida", () => {
    const msg = lida(conteudo());
    expect(msg.anuncio).toMatchObject({ sourceId: AD_REPLY.ctwaClid, adId: AD_REPLY.sourceID });
  });

  it("entrada comum tem anuncio nulo", () => {
    expect(lida("Olá! Vi o vídeo e quero saber mais.").anuncio).toBeNull();
  });

  it("SAÍDA nunca carrega anúncio — atribuição é de quem chega, não de quem responde", () => {
    expect(lida(conteudo(), { fromMe: true }).anuncio).toBeNull();
  });
});
