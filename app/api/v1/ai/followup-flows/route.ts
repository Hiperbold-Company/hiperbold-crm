import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/followup-flows — lista os fluxos da organização (viewer+).
 * POST /api/v1/ai/followup-flows — cria o fluxo em rascunho (manager+). Nasce status='draft',
 *   draft_graph null, trigger_config default 'manual' (default do banco).
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/followup/administracao.ts`, a mesma das tools MCP.
 * Auth: sessão OU token `dsk_…` (`mcp:read` / `mcp:write`, no mesmo piso de papel da tela); a organização
 * sai da sessão/da linha do token.
 */
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { criarFluxo, listarFluxos } from "@/lib/followup/administracao";
import { createFollowupFlowSchema } from "@/lib/followup/api-schemas";
import { entradaDeFluxo } from "@/lib/followup/porta";

export const dynamic = "force-dynamic";

/**
 * `?surface=atendimento` lista os roteiros de atendimento (a tela deles chega no
 * PR 3). Sem o parâmetro, só os fluxos do RELÓGIO — a tela de Follow-ups, o
 * seletor de fluxos do agente e a ação de webhook "inscrever" leem daqui, e na
 * prova prática do #1130 os roteiros apareciam nessas listas como se fossem
 * follow-ups (e abriam no editor de follow-up).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const e = await entradaDeFluxo(req, { escrita: false, role: "viewer" });
  if (e.resposta) return e.resposta;
  try {
    const surface = req.nextUrl.searchParams.get("surface") === "atendimento" ? "atendimento" : undefined;
    return ok(await listarFluxos(e.deps, { surface }), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entradaDeFluxo(req, { escrita: true, role: "manager" });
  if (e.resposta) return e.resposta;
  const t = e.deps.t!;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId: e.requestId });
  }
  const parsed = createFollowupFlowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await criarFluxo(e.deps, parsed.data), { requestId: e.requestId, status: 201 });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
