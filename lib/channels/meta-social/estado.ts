/**
 * O `state` do OAuth do canal social e o cookie de vínculo — o molde de
 * `lib/agenda/google/estado.ts` e `vinculo.ts`, com DOMÍNIO próprio.
 *
 * Por que não reaproveitar o do Google: os dois assinariam com o mesmo
 * `INTERNAL_SECRET` e o mesmo formato de carga, e um `state` emitido para a
 * agenda passaria aqui. A carga começa por `meta_social.<plataforma>.`, e quem
 * verifica exige o prefixo e a plataforma do caminho de volta: um state do
 * Instagram não conclui o Messenger e vice-versa.
 *
 * O nonce é queimado pelo callback em `calendar_oauth_nonces` (a mesma tabela
 * de uso único que Google Ads e Nuvemshop já compartilham; 23505 = replay).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { ehPlataformaMetaSocial, type PlataformaMetaSocial } from "./constantes";

export const VALIDADE_DO_ESTADO_MS = 10 * 60 * 1000;
export const NOME_DO_VINCULO_META_SOCIAL = "crm_meta_social_bind";
export const VALIDADE_DO_VINCULO_S = 10 * 60;

const DOMINIO = "meta_social";

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

const assinar = (carga: string, segredo: string): Buffer =>
  createHmac("sha256", segredo).update(carga, "utf8").digest();

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
  const campos = [dados.organizationId, dados.userId, dados.authSessionId ?? ""];
  if (campos.some((c) => c.includes("."))) throw new Error("campo do state com ponto");
  if (!dados.organizationId || !dados.userId) throw new Error("state sem organização ou usuário");
  const nonce = opcoes.nonce?.trim() || randomBytes(16).toString("hex");
  const expira = opcoes.agora.getTime() + VALIDADE_DO_ESTADO_MS;
  const carga = [
    DOMINIO,
    dados.plataforma,
    dados.organizationId,
    dados.userId,
    nonce,
    String(expira),
    ...(dados.authSessionId ? [dados.authSessionId] : []),
  ].join(".");
  return `${Buffer.from(carga, "utf8").toString("base64url")}.${assinar(carga, segredo).toString("hex")}`;
}

export function verificarEstadoMetaSocial(
  token: string | null | undefined,
  opcoes: { segredo: string; agora: Date; plataforma: PlataformaMetaSocial },
): EstadoMetaSocial | null {
  if (!token) return null;
  const segredo = segredoValido(opcoes.segredo);
  const partes = token.split(".");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  const carga = Buffer.from(partes[0], "base64url").toString("utf8");
  const esperada = assinar(carga, segredo);
  if (!/^[0-9a-f]+$/i.test(partes[1])) return null;
  const recebida = Buffer.from(partes[1], "hex");
  if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return null;

  const c = carga.split(".");
  if (c.length !== 6 && c.length !== 7) return null;
  const [dominio, plataforma, organizationId, userId, nonce, expiraTexto, authSessionId] = c;
  if (dominio !== DOMINIO || !ehPlataformaMetaSocial(plataforma)) return null;
  if (plataforma !== opcoes.plataforma) return null;
  const expiraEmMs = Number(expiraTexto);
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
