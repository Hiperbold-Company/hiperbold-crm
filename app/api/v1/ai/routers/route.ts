import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/routers — lista routers da org (agent+), com member_count.
 * POST /api/v1/ai/routers — cria router (admin), audit `ai.router_created`.
 *
 * Intent Router (Fase 3 do épico harness — spec 2026-07-23, migration 0085).
 * organization_id vem SEMPRE da sessão/da linha do token — nunca do body. Unique parcial
 * index (channel_session_id where is_active) garante 1 router ativo por sessão
 * — violação vira 409 tratado, não 500 cru.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/ai/agents/roteadores.ts`, a mesma das tools MCP.
 * Auth: sessão OU token `dsk_…` (`agent`+`mcp:read` para ler; `admin`+`mcp:write` para escrever, como a tela).
 */
import { type NextRequest } from "next/server";

import { criarRoteador, criarRoteadorSchema, listarRoteadores } from "@/lib/ai/agents/roteadores";
import { entradaDeRoteador } from "@/lib/ai/agents/roteadores-porta";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const e = await entradaDeRoteador(req, { escrita: false, role: "agent" });
  if (e.resposta) return e.resposta;
  try {
    return ok(await listarRoteadores(e.deps), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entradaDeRoteador(req, { escrita: true, role: "admin" });
  if (e.resposta) return e.resposta;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", e.t("Body JSON inválido."), 400, { requestId: e.requestId });
  }
  const parsed = criarRoteadorSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", e.t("Campos inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await criarRoteador(e.deps, parsed.data), { status: 201, requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
