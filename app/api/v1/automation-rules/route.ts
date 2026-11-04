import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/automation-rules — lista as regras de automação da org (manager+).
 * POST /api/v1/automation-rules — cria uma regra (manager+). is_active NUNCA aceito no
 *   create (schema não tem o campo) — regra nasce pausada (default FALSE do banco).
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/operacao/regras-automaticas-admin.ts`, a mesma das tools MCP.
 * Auth: sessão OU token `dsk_…` (`manager` + `mcp:read` / `mcp:write`, como a tela); a organização sai da
 * sessão/da linha do token. Para uma chave, o segredo cifrado de `call_webhook` nunca volta na resposta.
 */
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import {
  MENSAGEM_CAMPO_DE_DATA_DO_CONTATO,
  campoDoGatilhoDeDataEhDoContato,
} from "@/lib/automation/campo-do-gatilho-de-data";
import { criarRegra, listarRegrasCompletas } from "@/lib/operacao/regras-automaticas-admin";
import { entradaDeRegra } from "@/lib/operacao/regras-automaticas-porta";
import { createAutomationRuleSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const e = await entradaDeRegra(req, { escrita: false, role: "manager" });
  if (e.resposta) return e.resposta;
  try {
    return ok(await listarRegrasCompletas(e.deps), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entradaDeRegra(req, { escrita: true, role: "manager" });
  if (e.resposta) return e.resposta;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", e.t("Dados inválidos."), 400, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  const { supabase, organizationId } = e.deps;
  const { requestId, t } = e;
  // Conferências do upstream (fonte da própria empresa e #2791), antes de `criarRegra`:
  // valem para a tela e para o token `dsk_`.
  const webhookSourceId = parsed.data.trigger_config?.webhook_source_id;
  if (typeof webhookSourceId === "string") {
    const { data: source, error: sourceError } = await supabase
      .from("webhook_sources")
      .select("id")
      .eq("id", webhookSourceId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (sourceError) return fail("internal_error", t("Não foi possível conferir a fonte."), 500, { requestId });
    if (!source) {
      return fail("invalid_request", t("A fonte escolhida não pertence a esta empresa."), 422, { requestId });
    }
  }
  const campoDeData = await campoDoGatilhoDeDataEhDoContato(
    supabase,
    organizationId,
    parsed.data.trigger_event,
    parsed.data.trigger_config,
  );
  if ("erro" in campoDeData) return fail("internal_error", t("Não foi possível conferir o gatilho."), 500, { requestId });
  if (campoDeData.doContato) {
    return fail("invalid_request", t(MENSAGEM_CAMPO_DE_DATA_DO_CONTATO), 422, { requestId });
  }

  try {
    return ok(await criarRegra(e.deps, parsed.data), { requestId: e.requestId, status: 201 });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
