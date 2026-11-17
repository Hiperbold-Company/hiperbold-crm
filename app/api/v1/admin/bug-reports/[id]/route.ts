import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/admin/bug-reports/:id — o relato inteiro, com URL assinada de 5 min para o print.
 * PATCH /api/v1/admin/bug-reports/:id — `{ status, admin_note? }`: troca o status e audita
 *       `bug_report.status_changed`.
 *
 * Só administrador da instalação; a escrita exige escopo `full` (requirePlatformAdminEscrita).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { BUCKET_DOS_RELATOS, STATUS_DO_RELATO } from "@/lib/relatos/regras";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Validade da URL assinada do print. */
const VALIDADE_DO_PRINT_SEG = 300;

const idSchema = z.string().uuid();
const corpoSchema = z.object({
  status: z.enum(STATUS_DO_RELATO),
  admin_note: z.string().trim().max(2000).nullable().optional(),
});

type OrgDoJoin = { display_name: string | null } | { display_name: string | null }[] | null;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return fail("not_found", "Bug report not found", 404, { requestId });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("bug_reports")
    .select(
      "id, organization_id, user_id, description, page_url, context, screenshot_path, status, admin_note, created_at, updated_at, organizations!bug_reports_organization_id_fkey(display_name)",
    )
    .eq("id", id.data)
    .maybeSingle();
  if (error) return fail("internal_error", "Failed to fetch bug report", 500, { requestId });
  if (!data) return fail("not_found", "Bug report not found", 404, { requestId });

  const { organizations, ...linha } = data as unknown as {
    user_id: string | null;
    screenshot_path: string | null;
    organizations: OrgDoJoin;
  } & Record<string, unknown>;
  let printUrl: string | null = null;
  if (linha.screenshot_path) {
    const { data: assinada } = await admin.storage
      .from(BUCKET_DOS_RELATOS)
      .createSignedUrl(linha.screenshot_path, VALIDADE_DO_PRINT_SEG);
    printUrl = assinada?.signedUrl ?? null;
  }
  let email: string | null = null;
  if (linha.user_id) {
    const { data: u } = await admin.auth.admin.getUserById(linha.user_id);
    email = u?.user?.email ?? null;
  }
  const org = Array.isArray(organizations) ? organizations[0] : organizations;
  return ok(
    { ...linha, empresa: org?.display_name ?? null, usuario_email: email, print_url: printUrl },
    { requestId },
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return fail("not_found", "Bug report not found", 404, { requestId });
  const relatoId = id.data;

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) return fail("validation_failed", "Invalid request body", 400, { requestId });

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("bug_reports")
    .select("id, organization_id, status")
    .eq("id", id.data)
    .maybeSingle();
  if (erroLeitura) return fail("internal_error", "Failed to fetch bug report", 500, { requestId });
  if (!atual) return fail("not_found", "Bug report not found", 404, { requestId });
  const anterior = atual as { organization_id: string; status: string };

  const mudanca: Record<string, unknown> = { status: corpo.data.status, updated_at: new Date().toISOString() };
  if (corpo.data.admin_note !== undefined) mudanca.admin_note = corpo.data.admin_note || null;
  const { error } = await admin.from("bug_reports").update(mudanca).eq("id", id.data);
  if (error) return fail("internal_error", "Failed to update bug report", 500, { requestId });

  await audit({
    action: "bug_report.status_changed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    organizationId: anterior.organization_id,
    resourceType: "bug_reports",
    resourceId: relatoId,
    requestId,
    bypassedRls: true,
    metadata: { de: anterior.status, para: corpo.data.status },
  });

  return ok({ id: id.data, status: corpo.data.status }, { requestId });
}
