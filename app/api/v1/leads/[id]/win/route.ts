import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/win
 *
 * Closes a lead as won by moving it to the pipeline's `is_won=true` stage.
 * The DB trigger `fn_crm_lead_close_on_stage` sets status='won' + closed_at (P-02).
 * Idempotent: already-won leads return 200 with the current row.
 *
 * A regra vive em `lib/leads/encerramento.ts`, compartilhada com a capacidade de
 * encerramento da IA (IA 360 · wave 2). Duas implementações fariam a IA e o
 * humano fecharem negócio por critérios diferentes.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { autorizarAdministracao } from "@/lib/api/auth-dual-admin";
import { encerraDemanda } from "@/lib/leads/encerramento";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  // spec 13 §4: escrita é agent+ (viewer é read-only). Sessão OU token
  // (`role:agent`+, `mcp:write`); com a empresa em visibilidade `own` o token
  // de papel abaixo de gerente é recusado (D-148).
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    escrita: true,
    comDono: true,
  });
  if (!authz.ok) return authz.response;
  const supabase = authz.supabase;

  // O MOTIVO DE GANHO (issue #1536): corpo opcional. Body vazio/ausente é o
  // contrato antigo — ganhar sem motivo continua valendo, salvo quando o funil
  // liga `settings.won_reason_required` (aí a recusa vem de `encerraDemanda`).
  const corpo = await req.json().catch(() => ({}));
  const wonReason =
    typeof (corpo as { won_reason?: unknown }).won_reason === "string"
      ? ((corpo as { won_reason: string }).won_reason as string)
      : null;

  try {
    const { lead } = await encerraDemanda(
      supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor,
        requestId,
        idioma: authz.idioma,
      },
      { leadId, desfecho: "won", motivo: wonReason },
    );
    return ok(lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
