import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/pipelines/[id]/config — a configuração do funil: campos
 *                                       personalizados, motivos de ganho e perda,
 *                                       reabertura e vocabulário.
 * PATCH /api/v1/pipelines/[id]/config — grava (merge) a mesma configuração.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. O merge e o audit vivem em
 * `lib/pipelines/configuracao-do-funil.ts`, o MESMO núcleo da server action da
 * tela (`updatePipelineConfig`) e das tools MCP — e o corpo é validado pelo MESMO
 * `pipelineConfigPatchSchema` (`lib/schemas/settings.ts`).
 *
 * Auth: sessão OU token `dsk_…`. A escrita exige `admin` (como a action da tela)
 * e, no token, `role:admin` + `mcp:write`; a leitura, `manager` (+ `mcp:read`).
 * Segundo fator não existe para token — ver `lib/api/auth-dual-admin.ts`.
 * `organization_id` sai da sessão/da linha do token; funil de outra organização
 * responde 404, igual ao inexistente.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { atorDoAudit, autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { fail, ok, falhaInterna } from "@/lib/api/wrappers";
import {
  aplicarConfiguracaoDoFunil,
  lerConfiguracaoDoFunil,
} from "@/lib/pipelines/configuracao-do-funil";
import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_pipelines",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);
  const { id: pipelineId } = await ctx.params;

  const lida = await lerConfiguracaoDoFunil(authz.supabase, authz.organizationId, pipelineId);
  if (!lida.ok) {
    if (lida.error === "not_found") {
      return fail("not_found", t("Funil não encontrado."), 404, { requestId });
    }
    return falhaInterna("internal_error", new Error(lida.error), { requestId });
  }
  return ok(lida.dados, { requestId });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_pipelines",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);
  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }

  const parsed = pipelineConfigPatchSchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Não entendi o que mudar na configuração deste funil."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const aplicado = await aplicarConfiguracaoDoFunil(authz.supabase, {
    organizationId: authz.organizationId,
    pipelineId,
    patch: parsed.data,
    autor: atorDoAudit(authz),
    requestId,
  });
  if (!aplicado.ok) {
    if (aplicado.error === "not_found") {
      return fail("not_found", t("Funil não encontrado."), 404, { requestId });
    }
    if (aplicado.error === "conflict") {
      return fail("conflict", t("Outra pessoa alterou este funil ao mesmo tempo. Recarregue e tente de novo."), 409, {
        requestId,
      });
    }
    if (aplicado.error === "validation_failed" || aplicado.error === "invalid_request") {
      return fail("unprocessable_entity", t("Não entendi o que mudar na configuração deste funil."), 422, {
        requestId,
        details: aplicado.details as Record<string, unknown> | undefined,
      });
    }
    return falhaInterna("internal_error", new Error(aplicado.error), { requestId });
  }
  return ok(aplicado.dados, { requestId });
}
