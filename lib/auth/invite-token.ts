/**
 * Stateless HMAC-SHA256 invite token. Self-contained payload, signed and
 * base64url-encoded — no DB row required to issue. Verified at accept time.
 *
 * Format: `<body>.<sig>` where
 *   - body = base64url(JSON({invite_id, email, organization_id, role, exp}))
 *   - sig  = base64url(HMAC_SHA256(secret, body))
 *
 * Secret resolution: INVITE_TOKEN_SECRET → INTERNAL_SECRET → "dev-fallback".
 * Production deployments MUST set one of the first two, with 32+ characters:
 * em produção um segredo ausente, vazio ou curto NÃO assina nem verifica (D-126).
 * Verification uses `timingSafeEqual` to avoid timing oracles.
 */
import { z } from "zod";
import { interfaceSettingsSchema, type InterfaceSettings } from "@/lib/navigation/interface";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Tamanho mínimo do segredo de assinatura (hex de 16 bytes). */
export const INVITE_SECRET_MIN_LENGTH = 32;

/**
 * `||` e não `??`: a variável presente e VAZIA (o `.env.example` entrega chaves vazias)
 * cairia como chave vazia no HMAC, e qualquer um forjaria o convite (D-126). Fora de
 * produção o fallback de desenvolvimento continua valendo.
 */
const SECRET = (): string => {
  const segredo = process.env.INVITE_TOKEN_SECRET || process.env.INTERNAL_SECRET;
  if (segredo && segredo.length >= INVITE_SECRET_MIN_LENGTH) return segredo;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `invite_token_secret_ausente_ou_curto: INVITE_TOKEN_SECRET ou INTERNAL_SECRET precisa ter ${INVITE_SECRET_MIN_LENGTH}+ caracteres`,
    );
  }
  return "dev-fallback";
};

export interface InvitePayload {
  interface_settings?: InterfaceSettings;
  invite_id: string;
  email: string;
  organization_id: string;
  role: string;
  exp: number; // epoch seconds
  iat?: number;
  invited_by?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signInviteToken(payload: InvitePayload): string {
  const json = JSON.stringify(payload);
  const body = b64url(Buffer.from(json, "utf8"));
  const sig = b64url(createHmac("sha256", SECRET()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyInviteToken(token: string): InvitePayload | null {
  // Sem segredo utilizável (produção mal configurada) nenhum token é válido, e a página de
  // aceite mostra "convite inválido" em vez de quebrar.
  let segredo: string;
  try {
    segredo = SECRET();
  } catch {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", segredo).update(body).digest());
  if (sig.length !== expected.length) return null;

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: InvitePayload;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(json) as InvitePayload;
  } catch {
    return null;
  }

  const checked = z
    .object({
      invite_id: z.string().uuid(),
      email: z.string().email(),
      organization_id: z.string().uuid(),
      role: z.enum(["viewer", "agent", "manager", "admin"]),
      exp: z.number().int().positive(),
      iat: z.number().int().positive().optional(),
      invited_by: z.string().uuid().optional(),
      interface_settings: interfaceSettingsSchema.optional(),
    })
    .safeParse(payload);
  if (!checked.success) return null;
  payload = checked.data;

  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

export const INVITE_TTL_SECONDS = 60 * 60 * 24; // 24h

/**
 * PROVA DE QUE O LINK CHEGOU PELA CAIXA DE ENTRADA DO CONVIDADO (D-204).
 *
 * O `accept_url` aparece para quem convida (tela de Equipe, resposta da API) e pode ser reencaminhado, então o
 * token do convite sozinho NÃO prova a posse do e-mail. O link que sai POR E-MAIL leva, além do token, um
 * segundo segredo `v`: o HMAC dos campos do convite com o segredo do servidor, em domínio próprio (prefixo
 * fixo, para que a prova nunca coincida com a assinatura do token). Só o e-mail o contém. O `accept_url`
 * mostrado ao admin e devolvido pela API nunca leva `v`.
 *
 * Sem estado: a prova é recalculada dos campos do token, então vale para o token vigente e morre com ele
 * (outro convite, outro papel, outro `iat` ou `exp` dão outra prova). Reenviar o convite emite token novo e
 * prova nova. NUNCA vai para log nem audit.
 */
const DOMINIO_DA_PROVA_DO_EMAIL = "invite-email-proof.v1";

export function provaDoEmailDoConvite(payload: InvitePayload): string {
  const campos = [
    DOMINIO_DA_PROVA_DO_EMAIL,
    payload.invite_id,
    payload.email.trim().toLowerCase(),
    payload.organization_id,
    payload.role,
    String(payload.iat ?? ""),
    String(payload.exp),
  ].join("\n");
  return b64url(createHmac("sha256", SECRET()).update(campos).digest());
}

/** Comparação em tempo constante. Sem segredo utilizável (produção mal configurada), nada confere. */
export function provaDoEmailConfere(payload: InvitePayload, prova: string | null | undefined): boolean {
  if (typeof prova !== "string" || prova.length === 0) return false;
  let esperada: string;
  try {
    esperada = provaDoEmailDoConvite(payload);
  } catch {
    return false;
  }
  const a = Buffer.from(prova);
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Link de aceite que vai POR E-MAIL: o `accept_url` mais a prova de posse. Nunca devolvido por API nem exibido. */
export function linkDeAceiteDoEmail(acceptUrl: string, payload: InvitePayload): string {
  return `${acceptUrl}?v=${provaDoEmailDoConvite(payload)}`;
}
