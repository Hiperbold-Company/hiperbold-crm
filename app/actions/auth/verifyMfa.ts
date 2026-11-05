"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { confiarNesteDispositivo, DIAS_DE_CONFIANCA } from "@/lib/auth/dispositivo-confiavel";
import { mfaBloqueadoPorFalhas, registrarFalhaDeMfa } from "@/lib/auth/rate-limit";

// O contador do cookie é só a trava rápida da aba: a autoridade é o contador do
// SERVIDOR (`mfaBloqueadoPorFalhas`/`registrarFalhaDeMfa`), que apagar o cookie
// não zera (D-102).
const ATTEMPT_COOKIE = "mfa_attempts";
const ATTEMPT_TTL_SECONDS = 60;
const MAX_ATTEMPTS = 3;

export type VerifyMfaResult =
  | { ok: false; error: "mfa_invalid" }
  | { ok: false; error: "mfa_locked"; retry_in_seconds: number };

/**
 * Verifies a TOTP code against the user's verified factor and (on success)
 * elevates the session to AAL2. On failure, counts the attempt on the SERVER
 * (`registrarFalhaDeMfa`, D-102: clearing the cookie must not reset it) and in a
 * short-lived cookie. Either counter over its limit locks the user out.
 */
export async function verifyMfa(code: string, next?: string, confiar = false): Promise<VerifyMfaResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  // D-036: o primeiro salto do `x-forwarded-for` é forjável pelo cliente;
  // `ipDoCliente` lê o salto confiável (ver `lib/http/ip-do-cliente.ts`).
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Sanity-check: must have a verified TOTP factor.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const totp = factorsData?.totp?.find((f) => f.status === "verified");
  if (!totp) redirect("/app");

  // Lockout check (cookie counter).
  const store = await cookies();
  const raw = store.get(ATTEMPT_COOKIE)?.value;
  let attempts = 0;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) attempts = parsed;
  }
  if (attempts >= MAX_ATTEMPTS || (await mfaBloqueadoPorFalhas(user.id))) {
    return { ok: false, error: "mfa_locked", retry_in_seconds: ATTEMPT_TTL_SECONDS };
  }

  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "mfa_invalid" };
  }

  // Issue challenge + verify.
  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: "mfa_invalid" };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: totp.id,
    challengeId: challenge.id,
    code,
  });

  if (verifyErr) {
    await registrarFalhaDeMfa(user.id);
    const newAttempts = attempts + 1;
    store.set(ATTEMPT_COOKIE, String(newAttempts), {
      httpOnly: true,
      sameSite: "strict",
      secure: cookieSecure(),
      maxAge: ATTEMPT_TTL_SECONDS,
      path: "/",
    });
    const locked = newAttempts >= MAX_ATTEMPTS;
    await audit({
      action: "auth.mfa_failed",
      actorUserId: user.id,
      metadata: { locked, attempts: newAttempts },
      requestId,
      ip,
      userAgent,
    });
    if (locked) return { ok: false, error: "mfa_locked", retry_in_seconds: ATTEMPT_TTL_SECONDS };
    return { ok: false, error: "mfa_invalid" };
  }

  // Reset attempt counter and audit success.
  store.delete(ATTEMPT_COOKIE);
  await audit({
    action: "auth.mfa_success",
    actorUserId: user.id,
    metadata: {},
    requestId,
    ip,
    userAgent,
  });

  // O código já foi provado e a sessão já é aal2: falhar em LEMBRAR o navegador
  // não pode virar falha de login. Sem a linha, o próximo login só pede o código.
  const lembrou =
    confiar &&
    (await confiarNesteDispositivo(user.id, totp.id, userAgent).then(
      () => true,
      (e: unknown) => {
        logger.error("mfa_dispositivo_confiavel_falhou", {
          userId: user.id,
          message: e instanceof Error ? e.message : String(e),
        });
        return false;
      },
    ));
  if (lembrou) {
    await audit({
      action: "auth.mfa_device_trusted",
      actorUserId: user.id,
      resourceType: "user",
      resourceId: user.id,
      metadata: { dias: DIAS_DE_CONFIANCA },
      requestId,
      ip,
      userAgent,
    });
  }

  redirect(safeNext(next, "/app"));
}
