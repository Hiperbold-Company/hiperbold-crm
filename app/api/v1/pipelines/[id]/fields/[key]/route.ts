import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/pipelines/[id]/fields/[key] — altera um campo: label, required, options,
 *                                              obrigatorio_em (`null` limpa a regra).
 * DELETE /api/v1/pipelines/[id]/fields/[key] — remove a definição do campo.
 *
 * `key` e `type` não mudam depois de criados (o corpo é `strict`: mandá-los é 422). Remover o campo
 * NÃO apaga o valor que os negócios já guardam em `custom_fields` — a tela de configuração faz o
 * mesmo ao excluir o campo.
 *
 * Mesma regra, mesmo portão e mesmo núcleo de `POST /pipelines/[id]/fields`: ver o cabeçalho de
 * `lib/pipelines/campos-do-funil.ts`. Sessão OU token (`role:admin` + `mcp:write`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { autorizarAdministracao, traducaoDe, type AuthAdminOk } from "@/lib/api/auth-dual-admin";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import {
  alteracaoDeCampoSchema,
  alterarCampoDoFunil,
  removerCampoDoFunil,
  type DepsDosCampos,
} from "@/lib/pipelines/campos-do-funil";
import { customFieldSchema } from "@/lib/schemas/settings";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; key: string }>;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Entrada =
  | { requestId: string; resposta: Response }
  | {
      requestId: string;
      resposta?: undefined;
      authz: AuthAdminOk;
      pipelineId: string;
      key: string;
      deps: DepsDosCampos;
    };

async function entrada(req: NextRequest, ctx: RouteCtx): Promise<Entrada> {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_pipelines",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return { requestId, resposta: authz.response };
  const { id: pipelineId, key } = await ctx.params;
  if (!UUID_RX.test(pipelineId) || !customFieldSchema.shape.key.safeParse(key).success) {
    return { requestId, resposta: fail("invalid_request", "id ou chave inválidos.", 400, { requestId }) };
  }
  const deps: DepsDosCampos = {
    supabase: authz.supabase,
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };
  return { requestId, authz, pipelineId, key, deps };
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entrada(req, ctx);
  if (e.resposta) return e.resposta;
  const t = traducaoDe(e.authz);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId: e.requestId });
  }
  const parsed = alteracaoDeCampoSchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Não entendi o que mudar no campo."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await alterarCampoDoFunil(e.deps, e.pipelineId, e.key, parsed.data), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entrada(req, ctx);
  if (e.resposta) return e.resposta;
  try {
    return ok(await removerCampoDoFunil(e.deps, e.pipelineId, e.key), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
