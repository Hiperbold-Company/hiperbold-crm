import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/automation-rules/[id] — atualiza campos (inclui is_active — switch da UI).
 * DELETE /api/v1/automation-rules/[id] — remove a regra.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/operacao/regras-automaticas-admin.ts`, a mesma das tools MCP.
 * Auth: sessão OU token `dsk_…` (`manager` + `mcp:write`, como a tela); a organização sai da sessão/da linha do token.
 */
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, noContent, ok } from "@/lib/api/wrappers";
import { alterarRegra, apagarRegra } from "@/lib/operacao/regras-automaticas-admin";
import { entradaDeRegra } from "@/lib/operacao/regras-automaticas-porta";
import { updateAutomationRuleSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;
  const e = await entradaDeRegra(req, { escrita: true, role: "manager", id });
  if (e.resposta) return e.resposta;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = updateAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", e.t("Dados inválidos."), 400, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await alterarRegra(e.deps, id, parsed.data), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;
  const e = await entradaDeRegra(req, { escrita: true, role: "manager", id });
  if (e.resposta) return e.resposta;
  try {
    await apagarRegra(e.deps, id);
    return noContent(e.requestId);
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
