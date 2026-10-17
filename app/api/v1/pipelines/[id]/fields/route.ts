import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/pipelines/[id]/fields — os campos personalizados do funil.
 * POST /api/v1/pipelines/[id]/fields — acrescenta UM campo ao fim da lista.
 *
 * Existe ao lado de `PATCH /pipelines/[id]/config` (que SUBSTITUI a lista inteira) para a
 * operação por item: acrescentar um campo não exige reenviar — nem arriscar apagar — os outros.
 * Chave repetida (sem diferenciar maiúsculas) responde 409.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/pipelines/campos-do-funil.ts`, em cima do MESMO
 * núcleo da tela de configuração do funil (`lib/pipelines/configuracao-do-funil.ts`: trava
 * otimista + audit `pipeline.config_updated`).
 *
 * Auth: sessão OU token `dsk_…`. Escrita exige `admin` (como a tela) e, no token, `role:admin` +
 * `mcp:write`; leitura, `manager` + `mcp:read`. `organization_id` sai da sessão/da linha do token;
 * funil de outra organização responde 404. POST aceita `Idempotency-Key: <uuid>`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { criarComChaveOpcional } from "@/lib/api/criacao-idempotente";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import {
  criarCampoDoFunil,
  listarCamposDoFunil,
  novoCampoSchema,
  type DepsDosCampos,
} from "@/lib/pipelines/campos-do-funil";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_pipelines",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;
  const { id: pipelineId } = await ctx.params;
  if (!UUID_RX.test(pipelineId)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const deps: DepsDosCampos = {
    supabase: authz.supabase,
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };
  try {
    return ok(await listarCamposDoFunil(deps, pipelineId), { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
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
  if (!UUID_RX.test(pipelineId)) return fail("invalid_request", "id inválido.", 400, { requestId });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = novoCampoSchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Não entendi o campo. Informe key, label e type."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const deps: DepsDosCampos = {
    supabase: authz.supabase,
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };
  try {
    return await criarComChaveOpcional(req, authz, {
      requestId,
      endpoint: `/api/v1/pipelines/${pipelineId}/fields`,
      corpo: parsed.data,
      t,
      executar: () => criarCampoDoFunil(deps, pipelineId, parsed.data),
    });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
