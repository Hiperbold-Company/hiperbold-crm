import { describe, it, expect } from "vitest";
import {
  conferirAssinaturaDaCaptacao,
  mapInboundPayload,
  normalizePhoneBR,
  verifyInboundSignature,
} from "@/lib/webhooks/inbound";
import { createHmac } from "node:crypto";

describe("normalizePhoneBR", () => {
  it("já em E.164 com o nono passa direto", () => expect(normalizePhoneBR("+5511998765432")).toBe("+5511998765432"));
  it("DDD+numero BR ganha +55", () => expect(normalizePhoneBR("11 99876-5432")).toBe("+5511998765432"));
  it("com 55 na frente sem +", () => expect(normalizePhoneBR("5511998765432")).toBe("+5511998765432"));
  it("celular antigo sem o nono ganha o 9", () => {
    expect(normalizePhoneBR("+553284793302")).toBe("+5532984793302");
    expect(normalizePhoneBR("3284793302")).toBe("+5532984793302");
  });
  it("fixo BR 10 dígitos", () => expect(normalizePhoneBR("1133334444")).toBe("+551133334444"));
  it("lixo → null", () => expect(normalizePhoneBR("abc")).toBeNull());
  it("vazio/não-string → null", () => {
    expect(normalizePhoneBR("")).toBeNull();
    expect(normalizePhoneBR(42 as unknown)).toBeNull();
  });
});

describe("mapInboundPayload", () => {
  it("aliases default: nome/telefone/email", () => {
    const m = mapInboundPayload({ nome: "Ana", telefone: "11998765432", email: "a@b.com" });
    expect(m).toMatchObject({ name: "Ana", phone: "+5511998765432", email: "a@b.com" });
  });
  it("whatsapp como alias de phone; extras viram custom_fields; utm_* vira source_metadata", () => {
    const m = mapInboundPayload({ name: "Bo", whatsapp: "+5511998765432", empresa: "ACME", utm_source: "instagram" });
    expect(m.phone).toBe("+5511998765432");
    expect(m.custom_fields).toEqual({ empresa: "ACME" });
    expect(m.source_metadata).toEqual({ utm_source: "instagram" });
  });
  it("field_map custom tem precedência sobre defaults", () => {
    const m = mapInboundPayload({ contato: "Zé" }, { name: ["contato"] });
    expect(m.name).toBe("Zé");
  });
  it("payload sem nada mapeável → tudo null e extras preservados", () => {
    const m = mapInboundPayload({ foo: "bar" });
    expect(m.name).toBeNull();
    expect(m.phone).toBeNull();
    expect(m.custom_fields).toEqual({ foo: "bar" });
  });
  it("valores não-string são stringificados em custom_fields; objetos aninhados descartados", () => {
    const m = mapInboundPayload({ nome: "Ana", idade: 30, nested: { a: 1 } });
    expect(m.custom_fields).toEqual({ idade: "30" });
  });
});

describe("verifyInboundSignature", () => {
  const body = '{"nome":"Ana"}';
  const secret = "s3cr3t";
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  it("assinatura válida", () => expect(verifyInboundSignature(body, sig, secret)).toBe(true));
  it("assinatura errada", () => expect(verifyInboundSignature(body, "deadbeef", secret)).toBe(false));
  it("header ausente", () => expect(verifyInboundSignature(body, null, secret)).toBe(false));
  it("header com tamanho diferente não lança (timingSafeEqual exige mesmo length)", () =>
    expect(verifyInboundSignature(body, "abc", secret)).toBe(false));
});

describe("conferirAssinaturaDaCaptacao (D-215, carimbo contra reenvio)", () => {
  const rawBody = '{"nome":"Ana"}';
  const segredo = "s3cr3t";
  const agoraMs = 1_800_000_000_000;
  const agoraS = agoraMs / 1000;
  const assinar = (texto: string) => createHmac("sha256", segredo).update(texto).digest("hex");
  const base = { rawBody, segredo, agoraMs };

  it("com carimbo: valida o HMAC de `carimbo.corpo`", () => {
    const r = conferirAssinaturaDaCaptacao({
      ...base,
      carimbo: String(agoraS),
      assinatura: assinar(`${agoraS}.${rawBody}`),
      exigeCarimbo: false,
    });
    expect(r).toEqual({ valida: true, comCarimbo: true });
  });

  it("carimbo na borda de 300 s passa; 301 s recusa, nos dois sentidos", () => {
    const tenta = (c: number) =>
      conferirAssinaturaDaCaptacao({
        ...base,
        carimbo: String(c),
        assinatura: assinar(`${c}.${rawBody}`),
        exigeCarimbo: false,
      });
    expect(tenta(agoraS - 300).valida).toBe(true);
    expect(tenta(agoraS + 300).valida).toBe(true);
    expect(tenta(agoraS - 301)).toEqual({ valida: false, motivo: "carimbo_fora_da_janela" });
    expect(tenta(agoraS + 301)).toEqual({ valida: false, motivo: "carimbo_fora_da_janela" });
  });

  it("carimbo malformado é recusado como inválido", () => {
    for (const c of ["abc", "-5", "1.5", "1800000000000", "1e9"]) {
      const r = conferirAssinaturaDaCaptacao({
        ...base,
        carimbo: c,
        assinatura: assinar(`${c}.${rawBody}`),
        exigeCarimbo: false,
      });
      expect(r, c).toEqual({ valida: false, motivo: "carimbo_invalido" });
    }
  });

  it("sem carimbo e fonte que não exige: formato antigo continua valendo", () => {
    const r = conferirAssinaturaDaCaptacao({ ...base, carimbo: null, assinatura: assinar(rawBody), exigeCarimbo: false });
    expect(r).toEqual({ valida: true, comCarimbo: false });
  });

  it("sem carimbo e fonte que exige: recusa, mesmo com a assinatura antiga correta", () => {
    const r = conferirAssinaturaDaCaptacao({ ...base, carimbo: null, assinatura: assinar(rawBody), exigeCarimbo: true });
    expect(r).toEqual({ valida: false, motivo: "carimbo_ausente" });
  });

  it("com carimbo, a assinatura só do corpo não vale", () => {
    const r = conferirAssinaturaDaCaptacao({
      ...base,
      carimbo: String(agoraS),
      assinatura: assinar(rawBody),
      exigeCarimbo: false,
    });
    expect(r).toEqual({ valida: false, motivo: "assinatura_diferente" });
  });

  it("sem assinatura: recusa", () => {
    expect(conferirAssinaturaDaCaptacao({ ...base, carimbo: null, assinatura: null, exigeCarimbo: false })).toEqual({
      valida: false,
      motivo: "sem_assinatura",
    });
  });
});

describe("normalizePhoneBR: prefixos de tronco e '+' curto (auditoria 17/10/2026)", () => {
  it("0 de tronco e 00 internacional saem antes das regras de tamanho", () => {
    expect(normalizePhoneBR("011 99876-5432")).toBe("+5511998765432");
    expect(normalizePhoneBR("0055 11 99876-5432")).toBe("+5511998765432");
    expect(normalizePhoneBR("0 11 3333-4444")).toBe("+551133334444");
  });
  it("'+' com menos de 10 dígitos não é telefone", () => {
    expect(normalizePhoneBR("+123")).toBeNull();
    expect(normalizePhoneBR("+12345678")).toBeNull();
    expect(normalizePhoneBR("+0123456789")).toBeNull();
  });
});

describe("lerCorpoJsonObjeto", () => {
  it("só objeto passa; vazio vira {}", async () => {
    const { lerCorpoJsonObjeto } = await import("@/lib/webhooks/inbound");
    expect(lerCorpoJsonObjeto("")).toEqual({});
    expect(lerCorpoJsonObjeto('{"a":1}')).toEqual({ a: 1 });
    expect(lerCorpoJsonObjeto("null")).toBe("nao_objeto");
    expect(lerCorpoJsonObjeto("[1]")).toBe("nao_objeto");
    expect(lerCorpoJsonObjeto("7")).toBe("nao_objeto");
    expect(lerCorpoJsonObjeto("{x")).toBe("json_invalido");
  });
});
