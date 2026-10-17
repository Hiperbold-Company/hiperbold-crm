import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/:id/rollback  body: { version_id }
 * Aponta o fluxo para uma version já existente DELE (linhagem `pointer_id`), sem criar version nova
 * e sem forçar status='active': se estava 'disabled', continua 'disabled'.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/followup/administracao.ts`, a mesma das tools MCP.
 * Auth: sessão OU token `dsk_…` (`manager` + `mcp:write`, como a tela); a organização sai da sessão/da linha do token.
 */
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { reverterFluxo } from "@/lib/followup/administracao";
import { rollbackFollowupFlowSchema } from "@/lib/followup/api-schemas";
import { entradaDeFluxo } from "@/lib/followup/porta";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;
  const e = await entradaDeFluxo(req, { escrita: true, role: "manager", id });
  if (e.resposta) return e.resposta;
  const t = e.deps.t!;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId: e.requestId });
  }
  const parsed = rollbackFollowupFlowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await reverterFluxo(e.deps, id, parsed.data.version_id), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
