import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/agents/:id/publish  body: { version_id }
 *
 * Atomic flip via fn_publish_ai_agent_version (Spec 10 §4.5):
 *   - prev published version → 'superseded'
 *   - target version → 'published'
 *   - ai_agents.published_version_id → target
 * Valida credencial, channel_session, model e tool_ids antes do commit
 * (`capacidadesDesconhecidas` + `validarEscopoDaVersao`, em `lib/ai/agents/administracao.ts`).
 *
 * Erros de validação viram 422 com código estável (PublishErrorCode).
 * Emite event_log 'ai_agent.published' fire-and-forget depois do commit.
 *
 * Auth: sessão OU token `dsk_…` (`lib/api/auth-dual-admin.ts`): `admin` + `mcp:write`, o MESMO piso da
 * sessão; organização da sessão/da linha do token, nunca do body. A regra é compartilhada com a tool MCP.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizarAdministracao, pessoaResponsavel, traducaoDe } from "@/lib/api/auth-dual-admin";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { createAdminClient } from "@/lib/supabase/admin";
import { publishSchema } from "@/lib/ai/agents/validation";
import { publicarVersaoDoAgente } from "@/lib/ai/agents/administracao";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "ai_agents",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = publishSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const publicada = await publicarVersaoDoAgente(
      {
        supabase: authz.supabase,
        admin: createAdminClient(),
        organizationId: authz.organizationId,
        actor: authz.actor,
        responsavel: pessoaResponsavel(authz),
        requestId,
      },
      id,
      parsed.data.version_id,
    );
    return ok(publicada, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
