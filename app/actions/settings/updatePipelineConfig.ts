"use server";

import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { respostaParaOperador } from "@/lib/erros/para-operador";
import {
  pipelineConfigPatchSchema,
  type PipelineConfigPatch,
} from "@/lib/schemas/settings";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { aplicarConfiguracaoDoFunil, REGRAS_PERDEM_O_CAMPO } from "@/lib/pipelines/configuracao-do-funil";

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
  if (!podeAdministrarEmpresa(authUser, activeOrg)) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  // O núcleo é o mesmo da rota `PATCH /api/v1/pipelines/[id]/config` e das tools MCP
  // (`lib/pipelines/configuracao-do-funil.ts`): o merge de `settings` com trava otimista por
  // `updated_at`, a recusa do campo que o gatilho por data lê (#2791) e o audit moram lá.
  // O portão acima é o desta porta.
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");

  const aplicado = await aplicarConfiguracaoDoFunil(supabase, {
    organizationId: activeOrg.orgId,
    pipelineId,
    patch: parsed.data,
    autor: { actorUserId: authUser.id },
    requestId,
    idioma: authUser.idioma,
  });
  if (!aplicado.ok) {
    // #3747: a frase da tela vem do mapeador; o texto do Postgres fica no log.
    if (aplicado.erroDoBanco) {
      return respostaParaOperador(aplicado.erroDoBanco.erro, {
        contexto:
          aplicado.erroDoBanco.etapa === "leitura"
            ? "[pipeline.config] falha ao ler o pipeline"
            : "[pipeline.config] falha ao gravar a configuração do pipeline",
        idioma: authUser.idioma,
        campos: { pipeline_id: pipelineId },
      });
    }
    // #2791: a recusa já traz a frase com os nomes das regras, no idioma de quem salva.
    if ((aplicado.details as Record<string, unknown> | undefined)?.[REGRAS_PERDEM_O_CAMPO]) {
      return { ok: false, error: aplicado.error };
    }
    return { ok: false, error: aplicado.error, details: aplicado.details };
  }

  revalidatePath("/app/settings/tenant/pipelines");
  return { ok: true };
}
