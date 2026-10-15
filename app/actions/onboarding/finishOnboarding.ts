"use server";

/**
 * Server Action: finalize onboarding — stamps `onboarded_at`, audits, and
 * emits the `tenant.onboarded` domain event. Idempotent: only fires the
 * event the first time `onboarded_at` flips from NULL.
 */
import { redirect } from "next/navigation";

import { concluirOnboarding } from "@/lib/onboarding/concluir";
import { requireOnboardingCtx, OnboardingError } from "./_shared";

export type FinishOnboardingResult =
  | { ok: true; alreadyOnboarded: boolean }
  | { ok: false; error: "auth_required" | "no_active_org" | "forbidden" | "mfa_required" | "db_error"; details?: unknown };

export async function finishOnboarding(): Promise<FinishOnboardingResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx({ permitirConcluido: true });
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  const resultado = await concluirOnboarding({ orgId: ctx.orgId, userId: ctx.userId });
  if (!resultado.ok) return { ok: false, error: "db_error", details: resultado.detalhe };

  redirect("/app/inbox");
}
