import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/team/[user_id]/revoke — revoke a member.
 *
 * Guardrails (regra em `lib/team/administracao.ts`, a mesma das tools MCP):
 *  - Caller must be admin of the active org — sessão OU token (`role:admin` + `mcp:write`).
 *  - Cannot revoke self (nem a chave revoga o acesso do seu dono).
 *  - Cannot revoke the last admin.
 */
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { ok } from "@/lib/api/wrappers";
import { revogarAcessoDoMembro } from "@/lib/team/administracao";
import { entradaDeEquipe } from "@/lib/team/porta";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { user_id: targetUserId } = await ctx.params;
  const e = await entradaDeEquipe(req);
  if (e.resposta) return e.resposta;
  try {
    return ok(await revogarAcessoDoMembro(e.deps, targetUserId), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
