import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/agents/:id/pause (admin)
 *
 * Spec 10 §4.3. Limpa published_version_id (agente não responde gatilhos),
 * mas mantém archived_at=null. Versão antes-published vira 'superseded' pra
 * preservar continuidade do versionamento.
 *
 * Auth: sessão OU token `dsk_…` (`lib/api/auth-dual-admin.ts`): `admin` + `mcp:write`, o MESMO piso da
 * sessão; organização da sessão/da linha do token, nunca do body. A regra vive em
 * `lib/ai/agents/administracao.ts`, compartilhada com a tool MCP.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizarAdministracao, pessoaResponsavel } from "@/lib/api/auth-dual-admin";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { createAdminClient } from "@/lib/supabase/admin";
import { pausarAgente } from "@/lib/ai/agents/administracao";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "ai_agents",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return authz.response;

  try {
    return ok(
      await pausarAgente(
        {
          supabase: authz.supabase,
          admin: createAdminClient(),
          organizationId: authz.organizationId,
          actor: authz.actor,
          responsavel: pessoaResponsavel(authz),
          requestId,
        },
        id,
      ),
      { requestId },
    );
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
