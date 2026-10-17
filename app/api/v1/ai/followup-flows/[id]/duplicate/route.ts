import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/:id/duplicate — clona o ponteiro (manager+).
 *
 * Copia rascunho (ou a versão no ar, se o rascunho estiver vazio), gatilho e
 * política de handoff. A cópia nasce SEMPRE `draft`, sem `active_version_id`:
 * duplicar não publica e não passa a mandar mensagem. Nome recebe sufixo " (cópia)".
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/followup/administracao.ts`, a mesma das tools MCP.
 * Auth: sessão OU token `dsk_…` (`manager` + `mcp:write`, como a tela); a organização sai da sessão/da linha do token.
 */
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { ok } from "@/lib/api/wrappers";
import { duplicarFluxo } from "@/lib/followup/administracao";
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
    return ok(await duplicarFluxo(e.deps, id), { requestId: e.requestId, status: 201 });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
