/**
 * O cookie selado da ESCOLHA das contas da Meta (D-242): ida e volta, e cada
 * recusa — adulterado, outra plataforma, vencido, chave do `state`.
 */
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { emitirEstadoMetaSocial, verificarEstadoMetaSocial } from "@/lib/channels/meta-social/estado";
import {
  TETO_DA_SELECAO,
  VALIDADE_DA_SELECAO_MS,
  abrirSelecaoMetaSocial,
  selarSelecaoMetaSocial,
} from "@/lib/channels/meta-social/selecao";

const SEGREDO = "segredo-interno-com-mais-de-16-caracteres";
const AGORA = new Date("2026-11-19T12:00:00Z");
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const dados = {
  plataforma: "instagram" as const,
  organizationId: ORG,
  userId: USER,
  authSessionId: "sessao-1",
  modo: "instagram_sistema" as const,
  tokenFonteCifrado: "\\xc30d04070302-cifrado-pelo-banco",
  expiraEm: "2027-01-01T00:00:00.000Z",
  autorizadorId: "SU-1",
  empresaId: "BIZ-1",
};

const abrir = (valor: string, plataforma: "instagram" | "messenger" = "instagram", agora = AGORA) =>
  abrirSelecaoMetaSocial(valor, { segredo: SEGREDO, agora, plataforma });

describe("escolha pendente selada", () => {
  it("sela e abre: a carga volta inteira, com nonce novo e validade de 10 minutos", () => {
    const valor = selarSelecaoMetaSocial(dados, { segredo: SEGREDO, agora: AGORA });
    const lida = abrir(valor);
    expect(lida).toMatchObject({ ...dados, expiraEmMs: AGORA.getTime() + VALIDADE_DA_SELECAO_MS });
    expect(lida?.nonce).toMatch(/^[0-9a-f]{32}$/);
    // Cifrada: nem o token já cifrado pelo banco aparece no valor do cookie.
    expect(Buffer.from(valor, "base64url").toString("latin1")).not.toContain("cifrado-pelo-banco");
    // Duas seladas da mesma carga têm nonces diferentes.
    expect(abrir(selarSelecaoMetaSocial(dados, { segredo: SEGREDO, agora: AGORA }))?.nonce).not.toBe(lida?.nonce);
  });

  it("carga adulterada não abre", () => {
    const valor = selarSelecaoMetaSocial(dados, { segredo: SEGREDO, agora: AGORA });
    const bruto = Buffer.from(valor, "base64url");
    bruto[20] = bruto[20]! ^ 0x01;
    expect(abrir(bruto.toString("base64url"))).toBeNull();
    expect(abrir(`${valor.slice(0, -2)}AA`)).toBeNull();
    expect(abrir("lixo")).toBeNull();
    expect(abrir("")).toBeNull();
  });

  it("a escolha do Instagram não abre no caminho do Messenger", () => {
    const valor = selarSelecaoMetaSocial(dados, { segredo: SEGREDO, agora: AGORA });
    expect(abrir(valor, "messenger")).toBeNull();
  });

  it("vencida não abre", () => {
    const valor = selarSelecaoMetaSocial(dados, { segredo: SEGREDO, agora: AGORA });
    expect(abrir(valor, "instagram", new Date(AGORA.getTime() + VALIDADE_DA_SELECAO_MS - 1))).not.toBeNull();
    expect(abrir(valor, "instagram", new Date(AGORA.getTime() + VALIDADE_DA_SELECAO_MS + 1))).toBeNull();
  });

  it("outro segredo não abre", () => {
    const valor = selarSelecaoMetaSocial(dados, { segredo: SEGREDO, agora: AGORA });
    expect(
      abrirSelecaoMetaSocial(valor, { segredo: "outro-segredo-com-mais-de-16", agora: AGORA, plataforma: "instagram" }),
    ).toBeNull();
  });

  it("o state do OAuth não abre como escolha, e a escolha não vale como state", () => {
    const state = emitirEstadoMetaSocial(
      { plataforma: "instagram", organizationId: ORG, userId: USER },
      { segredo: SEGREDO, agora: AGORA },
    );
    expect(abrir(state)).toBeNull();
    const valor = selarSelecaoMetaSocial(dados, { segredo: SEGREDO, agora: AGORA });
    expect(verificarEstadoMetaSocial(valor, { segredo: SEGREDO, agora: AGORA, plataforma: "instagram" })).toBeNull();
  });

  it("carga cifrada com a CHAVE DO STATE (mesmo formato, mesmo dado associado) não abre", () => {
    // Monta à mão o que um `state` cifraria, mas com a carga da escolha: prova
    // que a chave é outra, e não só o formato.
    const chaveDoState = Buffer.from(hkdfSync("sha256", SEGREDO, "meta_social.state", "v1", 32));
    const carga = JSON.stringify({
      d: "meta_social_selecao",
      p: "instagram",
      o: ORG,
      u: USER,
      n: "nonce",
      e: AGORA.getTime() + 60_000,
      m: "instagram_sistema",
      t: "SUAT",
    });
    for (const aad of ["meta_social_selecao.v1.instagram", "meta_social.v1.instagram"]) {
      const iv = randomBytes(12);
      const cifra = createCipheriv("aes-256-gcm", chaveDoState, iv);
      cifra.setAAD(Buffer.from(aad, "utf8"));
      const corpo = Buffer.concat([cifra.update(carga, "utf8"), cifra.final()]);
      expect(abrir(Buffer.concat([iv, corpo, cifra.getAuthTag()]).toString("base64url"))).toBeNull();
    }
  });

  it("modo de outra plataforma é recusado ao selar", () => {
    expect(() =>
      selarSelecaoMetaSocial({ ...dados, plataforma: "messenger" }, { segredo: SEGREDO, agora: AGORA }),
    ).toThrow();
  });

  it("um token de ~600 caracteres cifrado pelo banco (hex de ~1400) cabe no cookie inteiro abaixo de 4000 bytes", () => {
    // `pgp_sym_encrypt` devolve bytea: "\x" + 2 caracteres por byte, com ~70 bytes de envelope.
    const cifrado = `\\x${"ab".repeat(700)}`;
    const valor = selarSelecaoMetaSocial({ ...dados, tokenFonteCifrado: cifrado }, { segredo: SEGREDO, agora: AGORA });
    expect(valor.length).toBeLessThan(TETO_DA_SELECAO);
    // Nome, valor e os atributos que `voltarParaEscolher` grava.
    const atributos = "; Path=/api/v1/channels/meta-social/selecao; Max-Age=600; HttpOnly; Secure; SameSite=Lax";
    expect(Buffer.byteLength(`crm_meta_social_selecao=${valor}${atributos}`)).toBeLessThan(4000);
    expect(abrir(valor)?.tokenFonteCifrado).toBe(cifrado);
    expect(() =>
      selarSelecaoMetaSocial({ ...dados, tokenFonteCifrado: "E".repeat(4000) }, { segredo: SEGREDO, agora: AGORA }),
    ).toThrow();
  });
});
