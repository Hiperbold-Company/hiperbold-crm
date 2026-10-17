import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/ai/followup-flows/:id — fluxo completo (draft_graph, trigger_config, handoff_policy) — viewer+.
 * PATCH  /api/v1/ai/followup-flows/:id — atualiza campos parciais (manager+).
 *   draft_graph é validado só estruturalmente (flowGraphSchema) — a validação
 *   semântica de publish (reachability, coverage) roda em /publish.
 * DELETE /api/v1/ai/followup-flows/:id — apaga o fluxo (manager+). Inscrições
 *   e versões saem na ordem do núcleo; não dá para desfazer.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/followup/administracao.ts`, a mesma das tools MCP.
 * Auth: sessão OU token `dsk_…`; a organização sai da sessão/da linha do token.
 */
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { alterarFluxo, apagarFluxo, lerFluxo } from "@/lib/followup/administracao";
import { patchFollowupFlowSchema } from "@/lib/followup/api-schemas";
import { entradaDeFluxo } from "@/lib/followup/porta";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const e = await entradaDeFluxo(req, { escrita: false, role: "viewer", id });
  if (e.resposta) return e.resposta;
  try {
    return ok(await lerFluxo(e.deps, id), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
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
  const parsed = patchFollowupFlowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await alterarFluxo(e.deps, id, parsed.data), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;
  const e = await entradaDeFluxo(req, { escrita: true, role: "manager", id });
  if (e.resposta) return e.resposta;
  try {
    return ok(await apagarFluxo(e.deps, id), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
