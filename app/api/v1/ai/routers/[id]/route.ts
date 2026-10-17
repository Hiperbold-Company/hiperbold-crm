import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/ai/routers/:id — detalhe do router + membros (agent+).
 * PATCH  /api/v1/ai/routers/:id — atualiza campos (admin), audit `ai.router_updated`.
 * DELETE /api/v1/ai/routers/:id — remove o router (admin), audit `ai.router_deleted`.
 *   Cascade FK (migration 0085) já apaga ai_router_members junto.
 *
 * organization_id sempre da sessão/da linha do token — nunca do path/body.
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/ai/agents/roteadores.ts`, a mesma das tools MCP.
 */
import { type NextRequest } from "next/server";

import {
  alterarRoteador,
  alterarRoteadorSchema,
  apagarRoteador,
  lerRoteador,
} from "@/lib/ai/agents/roteadores";
import { entradaDeRoteador } from "@/lib/ai/agents/roteadores-porta";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const e = await entradaDeRoteador(req, { escrita: false, role: "agent", id });
  if (e.resposta) return e.resposta;
  try {
    return ok(await lerRoteador(e.deps, id), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
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
  const parsed = alterarRoteadorSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", e.t("Campos inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await alterarRoteador(e.deps, id, parsed.data), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;
  const e = await entradaDeRoteador(req, { escrita: true, role: "admin", id });
  if (e.resposta) return e.resposta;
  try {
    return ok(await apagarRoteador(e.deps, id), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
