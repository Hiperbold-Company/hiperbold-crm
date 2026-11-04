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
import {
  MENSAGEM_CAMPO_DE_DATA_DO_CONTATO,
  campoDoGatilhoDeDataEhDoContato,
} from "@/lib/automation/campo-do-gatilho-de-data";
import { alterarRegra, apagarRegra } from "@/lib/operacao/regras-automaticas-admin";
import { entradaDeRegra } from "@/lib/operacao/regras-automaticas-porta";
import { updateAutomationRuleSchema } from "@/lib/schemas";
import { acoesQueFechamLaco, MENSAGEM_DO_LACO_DE_LEAD } from "@/lib/schemas/webhooks";

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
  const { supabase, organizationId } = e.deps;
  const { requestId, t } = e;

  // Conferências do upstream (#1528, #2791 e fonte da própria empresa), antes da regra de
  // `alterarRegra`: valem para a tela e para o token `dsk_`.
  const precisaDaGravada =
    parsed.data.trigger_event !== undefined ||
    parsed.data.actions !== undefined ||
    parsed.data.trigger_config !== undefined ||
    parsed.data.is_active === true;
  if (precisaDaGravada) {
    const { data: existing, error: fetchErr } = await supabase
      .from("automation_rules")
      .select("id, trigger_event, trigger_config, actions")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (fetchErr) return fail("internal_error", t("Não foi possível ler a regra."), 500, { requestId });
    if (!existing) return fail("not_found", t("Regra não encontrada."), 404, { requestId });

    // O PATCH parcial (só o gatilho, ou só as ações) monta o laço de #1528 pela
    // porta do lado: o schema só o vê quando os dois vêm juntos. Desligar a regra
    // (só `is_active`) nunca é barrado.
    const gravada = existing as {
      trigger_event: string;
      trigger_config: unknown;
      actions: { type: string }[] | null;
    };
    if (
      (parsed.data.trigger_event !== undefined || parsed.data.actions !== undefined) &&
      acoesQueFechamLaco(
        parsed.data.trigger_event ?? gravada.trigger_event,
        parsed.data.actions ?? gravada.actions ?? [],
      ).length
    ) {
      return fail("invalid_request", t(MENSAGEM_DO_LACO_DE_LEAD), 400, { requestId });
    }

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

    // Gatilho por data num campo do contato (#2791) nunca dispara: a regra que
    // chega assim — pela API, ou antiga sendo regravada ou religada — é recusada.
    // Desligar e renomear não passam por aqui.
    if (
      parsed.data.trigger_event !== undefined ||
      parsed.data.trigger_config !== undefined ||
      parsed.data.is_active === true
    ) {
      const campoDeData = await campoDoGatilhoDeDataEhDoContato(
        supabase,
        organizationId,
        parsed.data.trigger_event ?? gravada.trigger_event,
        parsed.data.trigger_config ?? gravada.trigger_config,
      );
      if ("erro" in campoDeData) return fail("internal_error", t("Não foi possível conferir o gatilho."), 500, { requestId });
      if (campoDeData.doContato) {
        return fail("invalid_request", t(MENSAGEM_CAMPO_DE_DATA_DO_CONTATO), 422, { requestId });
      }
    }
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
