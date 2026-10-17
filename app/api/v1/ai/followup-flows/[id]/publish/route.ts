import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/:id/publish — valida o draft_graph
 * (validateFlowForPublish) e, se válido, publica atomicamente via
 * fn_publish_followup_flow_version (migration 0056): insert da version +
 * ativação do pointer (active_version_id + status='active') numa função só.
 * EXECUTE da função é só service_role — por isso o núcleo usa o cliente de
 * servidor, com organization_id sempre filtrado (nunca do body).
 *
 * 422 validation_failed com details.errors se o rascunho faltar ou for reprovado.
 * PUBLICAR ARMA O GATILHO: a partir daqui o motor matricula contatos e manda as mensagens do fluxo.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/followup/administracao.ts`, a mesma das tools MCP.
 * Auth: sessão OU token `dsk_…` (`manager` + `mcp:write`, como a tela); a organização sai da sessão/da linha do token.
 */
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { ok } from "@/lib/api/wrappers";
import { publicarFluxo } from "@/lib/followup/administracao";
import { entradaDeFluxo } from "@/lib/followup/porta";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;
  const e = await entradaDeFluxo(req, { escrita: true, role: "manager", id });
  if (e.resposta) return e.resposta;
  try {
    return ok(await publicarFluxo(e.deps, id), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
