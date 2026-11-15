/**
 * O `state` do Cadastro Incorporado do WhatsApp (migration 1014): emitido pelo
 * `GET /api/v1/channels/official/cadastro-incorporado` e conferido no `POST`.
 *
 * Molde de `lib/channels/meta-social/estado.ts` (AES-256-GCM, chave por HKDF do
 * `INTERNAL_SECRET`), com DOMÍNIO PRÓPRIO no rótulo da HKDF e no dado associado:
 * um `state` do Instagram ou do Messenger não decifra aqui, e um daqui não decifra
 * lá, embora os dois saiam do mesmo segredo.
 *
 * O que ele prova no POST: que a conclusão veio de um início pedido por ESTE
 * usuário, nesta organização, há no máximo 15 minutos, e uma vez só (o nonce é
 * queimado em `calendar_oauth_nonces` antes da troca do código; 23505 = replay).
 * A organização que vale continua sendo a da sessão: o state só pode CONFIRMAR a
 * da sessão, nunca escolher outra.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const VALIDADE_DO_ESTADO_DO_CADASTRO_MS = 15 * 60 * 1000;

const DOMINIO = "whatsapp_cadastro_incorporado";
const VERSAO = "v1";
const TAMANHO_DO_IV = 12;
const TAMANHO_DA_TAG = 16;
const TETO_DO_STATE = 2048;

export interface EstadoDoCadastroIncorporado {
  organizationId: string;
  userId: string;
  authSessionId?: string;
  nonce: string;
  expiraEmMs: number;
}

function segredoValido(segredo: string): string {
  const s = segredo?.trim() ?? "";
  if (s.length < 16) throw new Error("INTERNAL_SECRET ausente ou curto demais para cifrar o state");
  return s;
}

function chaveDoEstado(segredo: string): Buffer {
  return Buffer.from(hkdfSync("sha256", segredo, `${DOMINIO}.state`, VERSAO, 32));
}

const DADO_ASSOCIADO = Buffer.from(`${DOMINIO}.${VERSAO}`, "utf8");

export function emitirEstadoDoCadastroIncorporado(
  dados: { organizationId: string; userId: string; authSessionId?: string },
  opcoes: { segredo: string; agora: Date; nonce?: string },
): string {
  const segredo = segredoValido(opcoes.segredo);
  if (!dados.organizationId || !dados.userId) throw new Error("state sem organização ou usuário");
  const nonce = opcoes.nonce?.trim() || randomBytes(16).toString("hex");
  const carga = JSON.stringify({
    d: DOMINIO,
    o: dados.organizationId,
    u: dados.userId,
    n: nonce,
    e: opcoes.agora.getTime() + VALIDADE_DO_ESTADO_DO_CADASTRO_MS,
    ...(dados.authSessionId ? { s: dados.authSessionId } : {}),
  });
  const iv = randomBytes(TAMANHO_DO_IV);
  const cifra = createCipheriv("aes-256-gcm", chaveDoEstado(segredo), iv);
  cifra.setAAD(DADO_ASSOCIADO);
  const corpo = Buffer.concat([cifra.update(carga, "utf8"), cifra.final()]);
  return Buffer.concat([iv, corpo, cifra.getAuthTag()]).toString("base64url");
}

const texto = (v: unknown): string => (typeof v === "string" ? v : "");

/** Decifra e confere; qualquer defeito (adulterado, outro domínio, vencido, lixo) = `null`. */
export function verificarEstadoDoCadastroIncorporado(
  token: string | null | undefined,
  opcoes: { segredo: string; agora: Date },
): EstadoDoCadastroIncorporado | null {
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
    decifra.setAAD(DADO_ASSOCIADO);
    decifra.setAuthTag(tag);
    const claro = Buffer.concat([decifra.update(corpo), decifra.final()]).toString("utf8");
    const lido: unknown = JSON.parse(claro);
    if (!lido || typeof lido !== "object") return null;
    carga = lido as Record<string, unknown>;
  } catch {
    return null;
  }

  if (carga.d !== DOMINIO) return null;
  const organizationId = texto(carga.o);
  const userId = texto(carga.u);
  const nonce = texto(carga.n);
  const authSessionId = texto(carga.s);
  const expiraEmMs = typeof carga.e === "number" ? carga.e : Number.NaN;
  if (!organizationId || !userId || !nonce || !Number.isFinite(expiraEmMs)) return null;
  if (opcoes.agora.getTime() > expiraEmMs) return null;
  return { organizationId, userId, nonce, expiraEmMs, ...(authSessionId ? { authSessionId } : {}) };
}
