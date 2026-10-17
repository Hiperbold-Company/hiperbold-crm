/**
 * GET /api/v1/webhook-sources/[id]/events — feed de recebimentos da fonte
 * (últimos 20), pra UI mostrar "chegou / não chegou" em tempo quase real
 * depois do botão "Enviar lead de teste".
 */
import { randomUUID } from "node:crypto";

import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import type { NextRequest } from "next/server";

import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  // Sessão OU token (`role:manager`+, `mcp:read`) — a org do token vem da linha dele.
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "webhook_sources",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);
  const activeOrg = { orgId: authz.organizationId };

  const supabase = authz.supabase;
  // D-128: `path_token` não é legível pela sessão. O papel (manager) já foi conferido e o filtro por
  // organização vai junto: o servidor só entrega o token de uma fonte DESTA organização.
  const { data: source, error: sourceErr } = await createAdminClient()
    .from("webhook_sources")
    .select("path_token")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (sourceErr) return falhaInterna("internal_error", sourceErr, { requestId });
  if (!source) return fail("not_found", t("Fonte não encontrada."), 404, { requestId });

  const { data, error } = await supabase
    .from("webhook_events_log")
    .select("id, created_at:received_at, valid_signature, payload_parsed, status")
    .eq("webhook_path_token", source.path_token)
    .order("received_at", { ascending: false })
    .limit(20);
  if (error) return falhaInterna("internal_error", error, { requestId });

  return ok(data ?? [], { requestId });
}
