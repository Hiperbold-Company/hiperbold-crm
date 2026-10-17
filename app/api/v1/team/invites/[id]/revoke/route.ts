/**
 * POST /api/v1/team/invites/[id]/revoke — cancela um convite pendente.
 *
 * admin-only. O token continua com assinatura e validade boas, mas o aceite
 * (`app/actions/team/acceptInvite.ts`) checa esta linha e recusa. É o único
 * jeito de cancelar um convite stateless.
 *
 * Idempotente: revogar de novo devolve 200 com `already_revoked: true`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  atorDoAudit,
  autorizarAdministracao,
  pessoaResponsavel,
  traducaoDe,
} from "@/lib/api/auth-dual-admin";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  // Sessão OU token (`role:admin` + `mcp:write`); org do token vem da linha dele.
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "team",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);
  const ator = atorDoAudit(authz);
  const activeOrg = { orgId: authz.organizationId };

  if (!z.string().uuid().safeParse(id).success) {
    return fail("invalid_request", t("Convite inválido."), 400, { requestId });
  }

  const supabase = authz.supabase;
  const { data: row, error: readErr } = await supabase
    .from("team_invites")
    .select("id, email, role, accepted_at, revoked_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (readErr) return falhaInterna("internal_error", readErr, { requestId });
  if (!row) return fail("not_found", t("Convite não encontrado."), 404, { requestId });
  if (row.accepted_at) {
    return fail("state_conflict", t("Este convite já foi aceito."), 409, { requestId });
  }
  if (row.revoked_at) {
    return ok({ id, already_revoked: true }, { requestId });
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("team_invites")
    .update({ revoked_at: nowIso, revoked_by: pessoaResponsavel(authz) })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .is("accepted_at", null)
    .is("revoked_at", null);
  if (updErr) return falhaInterna("internal_error", updErr, { requestId });

  await audit({
    action: "member.invite_revoked",
    ...ator,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: id,
    requestId,
    metadata: { email: row.email as string, role: row.role as string },
  });

  return ok({ id, revoked_at: nowIso }, { requestId });
}
