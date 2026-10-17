import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads — create lead (handler em ./_handler.ts).
 *
 * Sessão de navegador OU token de servidor (`dsk_…` com `role:agent`+ e
 * `mcp:write`), a mesma dualidade de `PATCH /api/v1/leads/[id]`. A org nunca vem
 * do corpo: no ramo do token ela sai da linha do token (`lib/api/auth-dual.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { autorizarAdministracao } from "@/lib/api/auth-dual-admin";
import { createLeadSchema, validateRequest, type CreateLeadInput } from "@/lib/schemas";

import { createLeadHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    escrita: true,
    comDono: true,
  });
  if (!authz.ok) return authz.response;

  let input;
  try {
    input = await validateRequest(createLeadSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = authz.supabase;

  try {
    const lead = await createLeadHandler(
      supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor,
        requestId,
        idioma: authz.idioma,
      },
      input as CreateLeadInput,
    );
    return ok(lead, { requestId, status: 201 });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
