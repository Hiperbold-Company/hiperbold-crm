import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/team/[user_id]/reactivate — devolve o acesso de um membro revogado.
 *
 * Revogar era uma porta que só abria por fora: a única forma de devolver o membro era emitir um convite novo —
 * caminho longo, cheio de beco (medido em 2026-09-10). Reativar é o inverso exato de revogar (espelho de
 * `../revoke/route.ts`: mesmos guardrails, mesma forma de resposta, mesma trilha).
 *
 * NÃO reaproveita `fn_accept_team_invite`: aquela função é o ACEITE, ato de quem foi convidado; aqui quem age é
 * quem ADMINISTRA, sobre um vínculo já aceito um dia (reescrever `accepted_at` apagaria quando a pessoa entrou).
 * NÃO devolve papel diferente do que a pessoa tinha: reativar é desfazer a revogação, não promover.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/team/administracao.ts`, a mesma das tools MCP.
 * Auth: sessão OU token (`role:admin` + `mcp:write`).
 */
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { ok } from "@/lib/api/wrappers";
import { reativarAcessoDoMembro } from "@/lib/team/administracao";
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
    return ok(await reativarAcessoDoMembro(e.deps, targetUserId), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
