import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/ai/routers/:id/members — substitui a lista INTEIRA de membros
 * do router (admin), audit `ai.router_members_updated`. `position` = índice
 * do array recebido. organization_id sempre da sessão/da linha do token.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/ai/agents/roteadores.ts`, a mesma das tools MCP.
 */
import { type NextRequest } from "next/server";

import { definirMembrosDoRoteador, membrosDoRoteadorSchema } from "@/lib/ai/agents/roteadores";
import { entradaDeRoteador } from "@/lib/ai/agents/roteadores-porta";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;
  const e = await entradaDeRoteador(req, { escrita: true, role: "admin", id });
  if (e.resposta) return e.resposta;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", e.t("Body JSON inválido."), 400, { requestId: e.requestId });
  }
  const parsed = membrosDoRoteadorSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", e.t("Campos inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await definirMembrosDoRoteador(e.deps, id, parsed.data.members), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
