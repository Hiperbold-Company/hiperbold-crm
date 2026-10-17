"use server";

import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  pipelineConfigPatchSchema,
  type PipelineConfigPatch,
} from "@/lib/schemas/settings";
import { aplicarConfiguracaoDoFunil } from "@/lib/pipelines/configuracao-do-funil";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { portaoDeAdminDaOrganizacao } from "@/lib/auth/portao-de-escrita";

export type UpdatePipelineConfigResult =
  | { ok: true }
  | { ok: false; error: string; details?: unknown };

export async function updatePipelineConfig(
  pipelineId: string,
  patch: PipelineConfigPatch,
): Promise<UpdatePipelineConfigResult> {
  if (!pipelineId || typeof pipelineId !== "string") {
    return { ok: false, error: "invalid_request" };
  }
  const parsed = pipelineConfigPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  const portao = await portaoDeAdminDaOrganizacao(authUser, activeOrg);
  if (!portao.ok) return { ok: false, error: portao.erro };

  // O núcleo é o mesmo da rota `PATCH /api/v1/pipelines/[id]/config` e das tools MCP
  // (`lib/pipelines/configuracao-do-funil.ts`): o portão acima é o desta porta.
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");

  const aplicado = await aplicarConfiguracaoDoFunil(supabase, {
    organizationId: activeOrg.orgId,
    pipelineId,
    patch: parsed.data,
    autor: { actorUserId: authUser.id },
    requestId,
  });
  if (!aplicado.ok) return { ok: false, error: aplicado.error, details: aplicado.details };

  revalidatePath("/app/settings/tenant/pipelines");
  return { ok: true };
}
