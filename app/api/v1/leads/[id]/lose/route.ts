import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/lose
 *
 * Closes a lead as lost (P-02). P-03 requires `lost_reason` (validated by Zod).
 * Moves the lead to the pipeline's `is_lost=true` stage; trigger
 * `fn_crm_lead_close_on_stage` sets status='lost' + closed_at.
 *
 * A regra vive em `lib/leads/encerramento.ts`, compartilhada com a capacidade de
 * encerramento da IA (IA 360 · wave 2). Duas implementações fariam a IA e o
 * humano fecharem negócio por critérios diferentes.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { loseLeadSchema, validateRequest } from "@/lib/schemas";

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
  const t = traducaoDe(authz);

  try {
    const input = await validateRequest(loseLeadSchema, req);
    const { lead } = await encerraDemanda(
      supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor,
        requestId,
        idioma: authz.idioma,
      },
      { leadId, desfecho: "lost", motivo: input.lost_reason },
    );
    return ok(lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      const fieldErrors = (err.details as { fieldErrors?: Record<string, unknown> } | undefined)?.fieldErrors;
      if (err.code === "validation_error" && fieldErrors && "lost_reason" in fieldErrors) {
        return fail("lost_reason_required", t("Informe o motivo da perda."), 422, { requestId });
      }
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
