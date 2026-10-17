/**
 * Shared handler: change a member's role (G2-02).
 *
 * Canonical route: PATCH /api/v1/team/[user_id]
 * Alias (EPIC-09, kept for existing callers): PATCH /api/v1/team/[user_id]/role
 *
 * Guardrails (regra em `lib/team/administracao.ts`, a mesma das tools MCP):
 *  - Caller must be admin of the active org (spec 13 §4) — sessão OU token
 *    `role:admin` + `mcp:write` (`lib/api/auth-dual-admin.ts`).
 *  - Cannot demote the last remaining admin (count check before write).
 *  - Cannot change role of a revoked member.
 */
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { changeRoleSchema, validateRequest } from "@/lib/schemas";
import { mudarPapelDoMembro } from "@/lib/team/administracao";
import { entradaDeEquipe } from "@/lib/team/porta";

export async function changeMemberRole(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const { user_id: targetUserId } = await ctx.params;

  const e = await entradaDeEquipe(req);
  if (e.resposta) return e.resposta;

  let input;
  try {
    input = await validateRequest(changeRoleSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId: e.requestId,
      });
    }
    throw err;
  }
  try {
    return ok(await mudarPapelDoMembro(e.deps, targetUserId, input.role), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
