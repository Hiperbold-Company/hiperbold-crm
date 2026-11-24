import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/admin/tenants/[id]/redesign
 *
 * Liga ou desliga o novo visual (redesign Hiperbold) de UMA empresa — fase 1
 * do lançamento: só o admin da plataforma decide, empresa por empresa. Quem lê
 * a chave é `redesignNaRequisicao()` (`lib/redesign/chave.ts`).
 *
 * Body `{ ligado: boolean }` (estrito). A empresa vem do CAMINHO, nunca do
 * corpo. Exige `requirePlatformAdminEscrita()` (scope full + MFA). Grava só
 * `settings.redesign` pela função do banco (`atualizarSettingDaOrganizacao`),
 * sem read-modify-write do jsonb inteiro. Pedir o estado que já está responde
 * 200 sem gravar nem auditar.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { invalidarOrg } from "@/lib/auth/cache-curto";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { atualizarSettingDaOrganizacao } from "@/lib/organizations/atualizar-setting";
import { redesignDaEmpresa } from "@/lib/redesign/chave";

const bodySchema = z.object({ ligado: z.boolean() }).strict();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supportDenied = await requireSupportWrite((await params).id);
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: tenantId } = await params;

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, slug, settings")
    .eq("id", tenantId)
    .maybeSingle();
  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  const anterior = redesignDaEmpresa((org as { settings?: unknown }).settings);
  if (anterior === body.ligado) {
    return ok({ ligado: body.ligado }, { requestId });
  }

  const gravado = await atualizarSettingDaOrganizacao(admin, tenantId, ["redesign"], {
    ligado: body.ligado,
    alterado_em: new Date().toISOString(),
    alterado_por: adminCtx.user.id,
  });
  if (!gravado.ok) {
    if (gravado.motivo === "organizacao_nao_encontrada") {
      return fail("not_found", "Tenant not found", 404, { requestId });
    }
    return fail("internal_error", "Failed to update tenant redesign", 500, { requestId });
  }

  void audit({
    action: "tenant.redesign_changed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: tenantId,
    resourceType: "organization",
    resourceId: tenantId,
    requestId,
    metadata: {
      tenant_slug: (org as { slug?: string | null }).slug ?? null,
      ligado: body.ligado,
      anterior,
    },
  });

  // O redesign entra no próximo carregamento de tela de cada membro.
  invalidarOrg(tenantId);

  return ok({ ligado: body.ligado }, { requestId });
}
