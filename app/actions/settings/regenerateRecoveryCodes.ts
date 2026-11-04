"use server";

import { headers } from "next/headers";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";
import { avisarSobreCodigosDeRecuperacao } from "@/lib/auth/aviso-de-codigos-de-recuperacao";
import { sessionAal } from "@/lib/auth/server";

export type RegenerateRecoveryCodesResult =
  | { ok: true; recovery_codes: string[] }
  | { ok: false; error: string };

/**
 * Deletes existing user_recovery_codes for the current user and issues 10
 * fresh codes. Plaintext returned ONCE — never persisted.
 *
 * Gerar códigos é operação equivalente a MFA: com um código válido,
 * `useRecoveryCode` remove todos os fatores TOTP da conta. Por isso exige o
 * segundo fator PROVADO nesta sessão (aal2), como `desativarMfaDaConta`: com só
 * a senha (aal1) quem tem fator não gera códigos (D-136). O dono recebe um
 * e-mail a cada regeneração.
 */
export async function regenerateRecoveryCodes(): Promise<RegenerateRecoveryCodesResult> {
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
  if (!user) return { ok: false, error: "unauthenticated" };

  // Confirm user has a verified TOTP factor (regenerate is meaningless otherwise).
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasFactor = factors?.totp?.some((f) => f.status === "verified");
  if (!hasFactor) return { ok: false, error: "mfa_not_enrolled" };
  // Exige o código provado NESTA sessão (`aal2`), como desligar a verificação:
  // códigos novos desligam o fator pela porta da recuperação, então uma sessão
  // só com a senha — ou de um dispositivo confiável — não pode emiti-los.
  if ((await sessionAal()) !== "aal2") return { ok: false, error: "mfa_required" };

  // A tabela só aceita escrita do client de serviço (migration 0755): sem ele a
  // instalação não tem como gravar os códigos, e a resposta diz isso em vez de
  // tentar pelo client do usuário.
  if (!isServiceRoleConfigured()) return { ok: false, error: "service_unavailable" };

  const codes = generateRecoveryCodes();
  const rows = codes.map((c) => ({ user_id: user.id, code_hash: hashRecoveryCode(c) }));
  const admin = createAdminClient();
  const d = await admin.from("user_recovery_codes").delete().eq("user_id", user.id);
  const delErr: unknown = d.error;
  let insErr: unknown = null;
  if (!delErr) {
    const ins = await admin.from("user_recovery_codes").insert(rows);
    insErr = ins.error;
  }
  if (delErr) {
    const msg = (delErr as { message?: string }).message ?? "delete_failed";
    return { ok: false, error: msg };
  }
  if (insErr) {
    const msg = (insErr as { message?: string }).message ?? "insert_failed";
    return { ok: false, error: msg };
  }

  await audit({
    action: "mfa.recovery_codes_regenerated",
    actorUserId: user.id,
    resourceType: "user",
    resourceId: user.id,
    requestId,
    ip,
    userAgent,
    metadata: { count: codes.length },
  });
  await avisarSobreCodigosDeRecuperacao({ email: user.email, evento: "regenerados", ip });

  return { ok: true, recovery_codes: codes };
}
