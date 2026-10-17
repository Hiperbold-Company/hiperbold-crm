import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/message-templates/[id] — atualiza título/corpo/atalho.
 * DELETE /api/v1/message-templates/[id] — remove a resposta pronta.
 *
 * Regra em `lib/operacao/respostas-prontas.ts`. Sessão: a RLS `message_templates_write` decide
 * quem escreve o quê (dono da pessoal, manager+ da compartilhada). Token `dsk_…`: `manager` +
 * `mcp:write`, e só as COMPARTILHADAS — a resposta pessoal de um atendente responde 404 à chave.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, noContent, ok } from "@/lib/api/wrappers";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import { alterarRespostaPronta, apagarRespostaPronta } from "@/lib/operacao/respostas-prontas";
import { updateTemplateSchema } from "@/lib/schemas/templates";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function entrada(req: NextRequest) {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "message_templates",
    role: "agent",
    tokenRole: "manager",
    escrita: true,
  });
  if (!authz.ok) return { requestId, resposta: authz.response } as const;
  const deps: DepsDaOperacao = {
    supabase: authz.supabase,
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };
  return { requestId, authz, deps, resposta: undefined } as const;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entrada(req);
  if (e.resposta) return e.resposta;
  const t = traducaoDe(e.authz);
  const { id } = await params;
  if (!UUID_RX.test(id)) return fail("invalid_request", t("id inválido."), 400, { requestId: e.requestId });

  const raw = await req.json().catch(() => null);
  const parsed = updateTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  try {
    return ok(await alterarRespostaPronta(e.deps, id, parsed.data), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entrada(req);
  if (e.resposta) return e.resposta;
  const { id } = await params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", traducaoDe(e.authz)("id inválido."), 400, { requestId: e.requestId });
  }
  try {
    await apagarRespostaPronta(e.deps, id);
    return noContent(e.requestId);
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
