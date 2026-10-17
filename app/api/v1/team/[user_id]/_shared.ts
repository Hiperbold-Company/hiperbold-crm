/**
 * Shared handler: change a member's role (G2-02).
 *
 * Canonical route: PATCH /api/v1/team/[user_id]
 * Alias (EPIC-09, kept for existing callers): PATCH /api/v1/team/[user_id]/role
 *
 * Guardrails:
 *  - Caller must be admin of the active org (spec 13 §4) — sessão OU token
 *    `role:admin` + `mcp:write` (`lib/api/auth-dual-admin.ts`).
 *  - Cannot demote the last remaining admin (count check before write).
 *  - Cannot change role of a revoked member.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { atorDoAudit, autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { audit } from "@/lib/audit";
import { changeRoleSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export async function changeMemberRole(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "team",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const activeOrg = { orgId: authz.organizationId };
  const ator = atorDoAudit(authz);
  const t = traducaoDe(authz);

  let input;
  try {
    input = await validateRequest(changeRoleSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = authz.supabase;

  const { data: target, error: fetchErr } = await supabase
    .from("user_organizations")
    .select("id, user_id, role, revoked_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (fetchErr) return falhaInterna("internal_error", fetchErr, { requestId });
  if (!target) return fail("not_found", t("Membro não encontrado."), 404, { requestId });
  if (target.revoked_at) {
    return fail("state_conflict", t("Membro está revogado."), 409, { requestId });
  }

  if (target.role === "admin" && input.role !== "admin") {
    const { count, error: countErr } = await supabase
      .from("user_organizations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", activeOrg.orgId)
      .eq("role", "admin")
      .is("revoked_at", null);
    if (countErr) return falhaInterna("internal_error", countErr, { requestId });
    if ((count ?? 0) <= 1) {
      return fail(
        "state_conflict",
        t("Não é possível rebaixar o último admin do tenant."),
        409,
        { requestId },
      );
    }
  }

  // O papel só é gravado pelo servidor (migration 0929, D-125): o admin da organização já foi
  // conferido acima e a linha é a da organização ativa. O banco recusa deixar a organização sem admin.
  const { error: updErr } = await createAdminClient()
    .from("user_organizations")
    .update({ role: input.role, updated_at: new Date().toISOString() })
    .eq("id", target.id)
    .eq("organization_id", activeOrg.orgId);
  if (updErr) {
    if (updErr.message.includes("organizacao_sem_admin")) {
      return fail("state_conflict", t("Não é possível rebaixar o último admin do tenant."), 409, { requestId });
    }
    return falhaInterna("internal_error", updErr, { requestId });
  }

  await audit({
    action: "team.role_changed",
    ...ator,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: {
      target_user_id: targetUserId,
      old_role: target.role,
      new_role: input.role,
    },
  });

  return ok({ user_id: targetUserId, role: input.role }, { requestId });
}
