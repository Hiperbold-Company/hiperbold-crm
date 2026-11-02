/**
 * O `state` do OAuth do canal social e o cookie de vínculo — o molde de
 * `lib/agenda/google/estado.ts` e `vinculo.ts`, com DOMÍNIO próprio.
 *
 * Por que não reaproveitar o do Google: os dois assinariam com o mesmo
 * `INTERNAL_SECRET` e o mesmo formato de carga, e um `state` emitido para a
 * agenda passaria aqui. A carga leva o domínio `meta_social` e a plataforma, e
 * quem verifica exige os dois iguais ao caminho de volta: um state do
 * Instagram não conclui o Messenger e vice-versa.
 *
 * O nonce é queimado pelo callback em `calendar_oauth_nonces` (a mesma tabela
 * de uso único que Google Ads e Nuvemshop já compartilham; 23505 = replay).
 *
 * A CARGA É CIFRADA (AES-256-GCM), não só assinada. O `state` viaja na URL do
 * consentimento da Meta e volta na URL do callback — passa pelo histórico do
 * navegador, pelos logs de acesso da Meta e por qualquer proxy no caminho. Uma
 * carga só assinada (base64 da carga + HMAC) entregava a quem lesse a URL o id
 * da sessão de login (`authSessionId`), além da organização e do usuário. A
 * cifra autenticada dá as duas garantias de uma vez: ninguém lê e ninguém
 * altera. O id da sessão continua inteiro do lado de dentro, que é o que a
 * cerca do suporte (`fn_support_callback_write_allowed`) precisa no callback.
 *
 * A chave sai do `INTERNAL_SECRET` por HKDF com um rótulo deste domínio, e a
 * plataforma entra como dado associado: um `state` do Instagram não decifra no
 * caminho do Messenger, e nenhum `state` de outro domínio (agenda do Google,
 * assinado com o mesmo segredo) decifra aqui.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { ehPlataformaMetaSocial, type PlataformaMetaSocial } from "./constantes";

export const VALIDADE_DO_ESTADO_MS = 10 * 60 * 1000;
export const NOME_DO_VINCULO_META_SOCIAL = "crm_meta_social_bind";
export const VALIDADE_DO_VINCULO_S = 10 * 60;

const DOMINIO = "meta_social";
const VERSAO = "v1";
const TAMANHO_DO_IV = 12;
const TAMANHO_DA_TAG = 16;
/** Teto do `state` lido: a carga cifrada tem ~250 caracteres; acima disso é lixo. */
const TETO_DO_STATE = 2048;

export interface EstadoMetaSocial {
  plataforma: PlataformaMetaSocial;
  organizationId: string;
  userId: string;
  authSessionId?: string;
  nonce: string;
  expiraEmMs: number;
}

function segredoValido(segredo: string): string {
  const s = segredo?.trim() ?? "";
  if (s.length < 16) throw new Error("INTERNAL_SECRET ausente ou curto demais para assinar o state");
  return s;
}

function chaveDoEstado(segredo: string): Buffer {
  return Buffer.from(hkdfSync("sha256", segredo, `${DOMINIO}.state`, VERSAO, 32));
}

const dadoAssociado = (plataforma: PlataformaMetaSocial) => Buffer.from(`${DOMINIO}.${VERSAO}.${plataforma}`, "utf8");

export function emitirEstadoMetaSocial(
  dados: {
    plataforma: PlataformaMetaSocial;
    organizationId: string;
    userId: string;
    authSessionId?: string;
  },
  opcoes: { segredo: string; agora: Date; nonce?: string },
): string {
  const segredo = segredoValido(opcoes.segredo);
  if (!dados.organizationId || !dados.userId) throw new Error("state sem organização ou usuário");
  const nonce = opcoes.nonce?.trim() || randomBytes(16).toString("hex");
  const carga = JSON.stringify({
    d: DOMINIO,
    p: dados.plataforma,
    o: dados.organizationId,
    u: dados.userId,
    n: nonce,
    e: opcoes.agora.getTime() + VALIDADE_DO_ESTADO_MS,
    ...(dados.authSessionId ? { s: dados.authSessionId } : {}),
  });
  const iv = randomBytes(TAMANHO_DO_IV);
  const cifra = createCipheriv("aes-256-gcm", chaveDoEstado(segredo), iv);
  cifra.setAAD(dadoAssociado(dados.plataforma));
  const corpo = Buffer.concat([cifra.update(carga, "utf8"), cifra.final()]);
  return Buffer.concat([iv, corpo, cifra.getAuthTag()]).toString("base64url");
}

const texto = (v: unknown): string => (typeof v === "string" ? v : "");

export function verificarEstadoMetaSocial(
  token: string | null | undefined,
  opcoes: { segredo: string; agora: Date; plataforma: PlataformaMetaSocial },
): EstadoMetaSocial | null {
  if (!token || token.length > TETO_DO_STATE || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const segredo = segredoValido(opcoes.segredo);
  const bruto = Buffer.from(token, "base64url");
  if (bruto.length <= TAMANHO_DO_IV + TAMANHO_DA_TAG) return null;
  const iv = bruto.subarray(0, TAMANHO_DO_IV);
  const tag = bruto.subarray(bruto.length - TAMANHO_DA_TAG);
  const corpo = bruto.subarray(TAMANHO_DO_IV, bruto.length - TAMANHO_DA_TAG);

  let carga: Record<string, unknown>;
  try {
    const decifra = createDecipheriv("aes-256-gcm", chaveDoEstado(segredo), iv);
    decifra.setAAD(dadoAssociado(opcoes.plataforma));
    decifra.setAuthTag(tag);
    const claro = Buffer.concat([decifra.update(corpo), decifra.final()]).toString("utf8");
    const lido: unknown = JSON.parse(claro);
    if (!lido || typeof lido !== "object") return null;
    carga = lido as Record<string, unknown>;
  } catch {
    // Tag que não confere (adulterado, outro segredo, outra plataforma) ou lixo.
    return null;
  }

  const plataforma = carga.p;
  if (carga.d !== DOMINIO || !ehPlataformaMetaSocial(plataforma) || plataforma !== opcoes.plataforma) return null;
  const organizationId = texto(carga.o);
  const userId = texto(carga.u);
  const nonce = texto(carga.n);
  const authSessionId = texto(carga.s);
  const expiraEmMs = typeof carga.e === "number" ? carga.e : Number.NaN;
  if (!organizationId || !userId || !nonce || !Number.isFinite(expiraEmMs)) return null;
  if (opcoes.agora.getTime() > expiraEmMs) return null;
  return {
    plataforma,
    organizationId,
    userId,
    nonce,
    expiraEmMs,
    ...(authSessionId ? { authSessionId } : {}),
  };
}

/** Valor do cookie que amarra o navegador que saiu ao que volta. */
export function assinarVinculoMetaSocial(nonce: string, segredo: string): string {
  return createHmac("sha256", segredo).update(`${DOMINIO}:${nonce}`, "utf8").digest("base64url");
}

export function vinculoMetaSocialConfere(
  valorDoCookie: string | undefined,
  nonce: string,
  segredo: string,
): boolean {
  if (!valorDoCookie || !nonce || !segredo) return false;
  const a = Buffer.from(valorDoCookie, "utf8");
  const b = Buffer.from(assinarVinculoMetaSocial(nonce, segredo), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
