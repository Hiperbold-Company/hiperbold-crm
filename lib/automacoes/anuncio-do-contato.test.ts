/**
 * Os dados do anúncio de origem como variáveis do contato
 * (`{{contact.anuncio.*}}`): a leitura do que a ingestão gravou, o texto
 * renderizado, a gravação num campo personalizado pela operação "Definir" e a
 * leitura pelo seletor de campo (condições).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { patchContatoMock } = vi.hoisted(() => ({ patchContatoMock: vi.fn(async () => ({})) }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({ patchContactHandler: patchContatoMock }));

import { extrairAtribuicaoMeta } from "@/lib/channels/atribuicao-de-anuncio-oficial";
import type { PedidoDeEfeito } from "@/lib/followup/engine";
import type { FlowNode } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";

import { anuncioDoFluxo, anuncioVazio, CHAVES_DO_ANUNCIO } from "./anuncio-do-contato";
import { lerCampo } from "./condicoes";
import { criarExecutorDeEfeitos } from "./efeitos/index";
import type { FatosDaAutomacao } from "./fatos";
import { fieldRefSchema } from "./schemas";
import { renderizar } from "./template-vars";

const AGORA = new Date("2026-11-14T12:00:00Z");
const ORG = "00000000-0000-4000-8000-0000000000a1";
const CONTATO = "20000000-0000-4000-8000-000000000001";

/** O que `estamparAtribuicaoDoContato` grava para um clique em anúncio do WhatsApp. */
const SOURCE_METADATA = {
  ad_platform: "meta_ads",
  ad_source_id: "CLICK-123",
  ad_id: "AD-777",
  ad_title: "Sofá com 30% off",
  ad_body: "Só esta semana",
  ad_source_url: "https://fb.me/abc",
  ad_media_type: "video",
  ad_raw: { source_id: "AD-777", media_type: "video" },
};

function fatosCom(sourceMetadata: unknown, custom: Record<string, unknown> = {}): FatosDaAutomacao {
  return {
    contato: {
      id: CONTATO,
      name: "Maria",
      email: null,
      phone_number: null,
      birthdate: null,
      tags: [],
      custom_fields: custom,
      anuncio: anuncioDoFluxo(sourceMetadata),
    },
    negocio: null,
    negocios: [],
    vars: {},
  };
}

describe("anuncioDoFluxo: projeção do que a ingestão gravou", () => {
  it("as seis variáveis, na gramática do contato", () => {
    expect(anuncioDoFluxo(SOURCE_METADATA)).toEqual({
      ctwa_clid: "CLICK-123",
      source_id: "AD-777",
      source_url: "https://fb.me/abc",
      headline: "Sofá com 30% off",
      body: "Só esta semana",
      media_type: "video",
    });
    expect([...CHAVES_DO_ANUNCIO]).toEqual(Object.keys(anuncioVazio()));
  });

  it("sem anúncio: tudo string vazia, nunca undefined — para qualquer entrada", () => {
    for (const entrada of [null, undefined, {}, [], "x", 7, { ad_platform: null }, { ad_id: "sem plataforma" }]) {
      const a = anuncioDoFluxo(entrada);
      expect(a).toEqual(anuncioVazio());
      for (const v of Object.values(a)) expect(v).toBe("");
    }
  });

  it("contato carimbado antes da coluna `ad_media_type` lê o tipo do payload cru", () => {
    const { ad_media_type: _fora, ...antigo } = SOURCE_METADATA;
    void _fora;
    expect(anuncioDoFluxo(antigo).media_type).toBe("video");
    expect(anuncioDoFluxo({ ...antigo, ad_raw: { mediaType: "image" } }).media_type).toBe("image");
    expect(anuncioDoFluxo({ ...antigo, ad_raw: {} }).media_type).toBe("");
  });

  it("clique capturado na página (formulário) não é ctwa_clid", () => {
    const doSite = { ...SOURCE_METADATA, ad_click_source: "site", ad_source_id: "fbclid-xyz" };
    expect(anuncioDoFluxo(doSite).ctwa_clid).toBe("");
    expect(anuncioDoFluxo({ ...SOURCE_METADATA, ad_platform: "google_ads", ad_source_id: "gclid-1" }).ctwa_clid).toBe("");
    expect(anuncioDoFluxo(doSite).source_id).toBe("AD-777");
  });
});

describe("anuncioDoFluxo: teto por valor", () => {
  it("corta cada valor a 500 caracteres e não mexe no que cabe", () => {
    const longo = "x".repeat(900);
    const a = anuncioDoFluxo({ ...SOURCE_METADATA, ad_title: longo, ad_body: longo, ad_source_url: `https://a.co/${longo}` });
    expect(a.headline).toHaveLength(500);
    expect(a.body).toHaveLength(500);
    expect(a.source_url).toHaveLength(500);
    expect(a.source_id).toBe("AD-777");
    expect(anuncioDoFluxo({ ...SOURCE_METADATA, ad_body: "y".repeat(500) }).body).toHaveLength(500);
  });
});

describe("texto da automação", () => {
  it("{{contact.anuncio.*}} vira o valor, e a ausência vira vazio (nunca 'undefined')", () => {
    const texto = "[{{contact.anuncio.ctwa_clid}}|{{contact.anuncio.source_id}}|{{contact.anuncio.headline}}|{{contact.anuncio.media_type}}]";
    expect(renderizar(texto, fatosCom(SOURCE_METADATA), AGORA)).toBe("[CLICK-123|AD-777|Sofá com 30% off|video]");
    expect(renderizar(texto, fatosCom(null), AGORA)).toBe("[|||]");
    // Montador de fatos que não carrega o anúncio: também vazio.
    const semAnuncio = fatosCom(null);
    delete semAnuncio.contato!.anuncio;
    expect(renderizar("{{contact.anuncio.source_url}}", semAnuncio, AGORA)).toBe("");
    expect(renderizar("{{contact.anuncio.body|\"orgânico\"}}", fatosCom(null), AGORA)).toBe("orgânico");
    expect(renderizar("{{contact.anuncio.body}}", null, AGORA)).toBe("");
  });
});

describe("operação de campo: Definir com a variável do anúncio", () => {
  beforeEach(() => patchContatoMock.mockClear());

  function pedido(fatos: FatosDaAutomacao): PedidoDeEfeito {
    return {
      enrollment: { id: "e1", organization_id: ORG, contact_id: CONTATO, pointer_id: "p1" } as EnrollmentRow,
      node: {
        id: "campo-1",
        type: "field_op",
        label: "Gravar anúncio",
        position: { x: 0, y: 0 },
        config: {
          ops: [
            { target: { scope: "contact_custom", key: "anuncio_origem" }, op: "set", value: "{{contact.anuncio.source_id}}" },
            { target: { scope: "contact_custom", key: "anuncio_titulo" }, op: "set", value: "{{contact.anuncio.headline}}" },
            { target: { scope: "contact_custom", key: "anuncio_tipo" }, op: "set", value: "{{contact.anuncio.media_type}}" },
          ],
        },
      } as FlowNode,
      fatos,
      chave: "campo-1:1",
    };
  }
  const executor = () =>
    criarExecutorDeEfeitos({} as SupabaseClient, { podeProduzir: async () => true, clock: () => AGORA });

  it("grava o valor do anúncio no campo personalizado do contato", async () => {
    const r = await executor().executar(pedido(fatosCom(SOURCE_METADATA, { existente: "fica" })));
    expect(r.desfecho).toEqual({ ok: true });
    expect(patchContatoMock).toHaveBeenCalledTimes(1);
    const corpo = (patchContatoMock.mock.calls[0] as unknown[])[3] as { custom_fields: Record<string, unknown> };
    expect(corpo.custom_fields).toEqual({
      existente: "fica",
      anuncio_origem: "AD-777",
      anuncio_titulo: "Sofá com 30% off",
      anuncio_tipo: "video",
    });
  });

  it("contato sem anúncio grava vazio, nunca a palavra undefined", async () => {
    await executor().executar(pedido(fatosCom(null)));
    const corpo = (patchContatoMock.mock.calls[0] as unknown[])[3] as { custom_fields: Record<string, unknown> };
    expect(corpo.custom_fields).toEqual({ anuncio_origem: "", anuncio_titulo: "", anuncio_tipo: "" });
    expect(JSON.stringify(corpo)).not.toContain("undefined");
  });
});

describe("leitura pelo seletor de campo (condições)", () => {
  it("`var:contact.anuncio.<chave>` lê o anúncio do contato; chave desconhecida não passa", () => {
    for (const chave of CHAVES_DO_ANUNCIO) {
      expect(fieldRefSchema.safeParse({ scope: "var", path: `contact.anuncio.${chave}` }).success, chave).toBe(true);
    }
    expect(fieldRefSchema.safeParse({ scope: "var", path: "contact.anuncio.raw" }).success).toBe(false);
    // Caixa diferente da que `chaveDoAnuncioNoCaminho` lê não passa (leria vazio em silêncio)...
    for (const path of ["contact.anuncio.HEADLINE", "Contact.Anuncio.headline", "contact.ANUNCIO.body"]) {
      expect(fieldRefSchema.safeParse({ scope: "var", path }).success, path).toBe(false);
    }
    // ...e as outras variáveis seguem como eram.
    expect(fieldRefSchema.safeParse({ scope: "var", path: "gatilho.tipo" }).success).toBe(true);
    expect(fieldRefSchema.safeParse({ scope: "var", path: "Gatilho.Tipo" }).success).toBe(true);
    expect(fieldRefSchema.safeParse({ scope: "var", path: "contact.email" }).success).toBe(false);
    const ref = { scope: "var", path: "contact.anuncio.source_id" } as const;
    expect(lerCampo(ref, fatosCom(SOURCE_METADATA))).toBe("AD-777");
    expect(lerCampo(ref, fatosCom(null))).toBe("");
  });
});

describe("captura do media_type na ingestão", () => {
  it("o extrator do webhook oficial guarda o tipo de mídia do referral", () => {
    const a = extrairAtribuicaoMeta({
      source_type: "ad",
      source_id: "AD-777",
      ctwa_clid: "CLICK-123",
      headline: "Sofá",
      media_type: "video",
    });
    expect(a?.tipoDeMidia).toBe("video");
    expect(extrairAtribuicaoMeta({ source_type: "ad", source_id: "AD-1" })?.tipoDeMidia).toBeUndefined();
    expect(extrairAtribuicaoMeta({ source_type: "ad", source_id: "AD-1", mediaType: "image" })?.tipoDeMidia).toBe("image");
  });

  it("é gravado em `source_metadata.ad_media_type`, e só quando existe", async () => {
    const chamadas: Array<Record<string, unknown>> = [];
    const admin = {
      rpc: async (_nome: string, args: Record<string, unknown>) => {
        chamadas.push(args.p_metadata as Record<string, unknown>);
        return { error: null };
      },
    } as unknown as SupabaseClient;
    const base = { plataforma: "meta_ads" as const, sourceId: "C", adId: "A", titulo: "t", corpo: null, sourceUrl: null, bruto: {} };
    await estamparAtribuicaoDoContato(admin, ORG, CONTATO, { ...base, tipoDeMidia: "video" });
    await estamparAtribuicaoDoContato(admin, ORG, CONTATO, { ...base, tipoDeMidia: null });
    expect(chamadas[0]).toMatchObject({ ad_media_type: "video", ad_id: "A", ad_source_id: "C" });
    expect(chamadas[1]).not.toHaveProperty("ad_media_type");
  });
});
