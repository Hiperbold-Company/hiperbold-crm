import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/admin/tenants/[id]/ai-budget — gasto do mês x teto de IA da empresa.
 * PATCH /api/v1/admin/tenants/[id]/ai-budget — ajusta teto, limiar e modo.
 *
 * O teto de gasto de IA (em dólar, `ai_budgets`) é uma trava de segurança que
 * só o administrador da plataforma vê e ajusta (decisão do dono do produto,
 * 25/11/2026). A organização vem do PATH — nunca do corpo — e a escrita exige
 * `requirePlatformAdminEscrita()` (escopo `full` + MFA em dia), como as demais
 * escritas de `/api/v1/admin/tenants/[id]/*`.
 *
 * As regras da escrita (escada `off → avisar → bloquear`, piso, carência de
 * 72h, auditoria, retrato dos avisos) moram em
 * `lib/ai/budget/ajustar-orcamento.ts`; aqui só a autorização e o alvo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { getBudgetStatus } from "@/lib/ai/budget/check";
import { ajustarOrcamentoDeIa } from "@/lib/ai/budget/ajustar-orcamento";
import { normalizarIdioma, parseAcceptLanguage } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Contexto = { params: Promise<{ id: string }> };

const idSchema = z.string().uuid();

function idiomaDe(req: NextRequest, ctx: PlatformAdminContext) {
  const preferido = ctx.user.user_metadata?.locale;
  return normalizarIdioma(
    typeof preferido === "string" ? preferido : parseAcceptLanguage(req.headers.get("accept-language")),
  );
}

export async function GET(_req: NextRequest, { params }: Contexto): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  try {
    await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  if (!idSchema.safeParse(id).success) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  const status = await getBudgetStatus(id);
  return ok(status, { requestId });
}

export async function PATCH(req: NextRequest, { params }: Contexto): Promise<Response> {
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
  const idioma = idiomaDe(req, adminCtx);

  if (!idSchema.safeParse(tenantId).success) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  const admin = createAdminClient();
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id")
    .eq("id", tenantId)
    .maybeSingle();
  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_failed", traduzir("JSON inválido.", idioma), 422, { requestId });
  }

  return ajustarOrcamentoDeIa({
    orgId: tenantId,
    actorUserId: adminCtx.user.id,
    body,
    idioma,
    requestId,
    comoAdminDaPlataforma: true,
  });
}
