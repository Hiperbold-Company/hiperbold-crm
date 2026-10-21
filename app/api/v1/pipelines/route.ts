import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/pipelines — lista os funis da org ativa (nome + slug), RLS-scoped.
 * Existia só o handler interno (usado pelo MCP); expõe REST pro Select de
 * pipeline do CreateSourceDialog (feature Webhooks).
 *
 * POST /api/v1/pipelines — cria um funil COM as etapas com que ele nasce.
 *
 * ⚠️ O POST é só transporte: a regra vive em `lib/pipelines/administracao.ts`, a mesma das tools MCP.
 * Auth: sessão OU token `dsk_…` (`role:manager`+, `mcp:read` / `mcp:write`) — a org do token vem da linha dele.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { criarFunil } from "@/lib/pipelines/administracao";
import { listPipelinesHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "pipelines",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  try {
    const { pipelines } = await listPipelinesHandler(authz.supabase, {
      organization_id: authz.organizationId,
      actor: authz.actor,
      requestId,
    });
    return ok(pipelines, { requestId });
  } catch {
    return fail("internal_error", t("Falha ao listar funis."), 500, { requestId });
  }
}

// `.max(80)`: o nome é o título de uma linha da lista e o topo do quadro, não um parágrafo.
const bodySchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(280).nullable().optional(),
  })
  .strict();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_pipelines",
    role: "manager",
    escrita: true,
    permissao: "funis.editar",
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Dê um nome ao funil — é o que aparece na lista."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const corpo = await criarFunil(
      { supabase: authz.supabase, organizationId: authz.organizationId, actor: authz.actor, requestId, t },
      parsed.data,
    );
    return ok(corpo, { status: 201, requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
