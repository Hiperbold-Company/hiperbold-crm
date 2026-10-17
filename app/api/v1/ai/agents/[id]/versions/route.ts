import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/agents/:id/versions  — list (manager+).
 * POST /api/v1/ai/agents/:id/versions  — create new draft (admin) = "Save".
 *
 * Spec 10 §4.4. Calcula próximo version_number = max(version_number)+1 com
 * unique constraint cobrindo a corrida; em caso de 23505, tenta novamente uma
 * vez.
 *
 * Auth: sessão OU token `dsk_…` (`lib/api/auth-dual-admin.ts`): o MESMO piso de papel da sessão,
 * `mcp:read` para ler e `mcp:write` para escrever; organização da sessão/da linha do token, nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { criarComChaveOpcional } from "@/lib/api/criacao-idempotente";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { ok, fail } from "@/lib/api/wrappers";
import { autorizarAdministracao, pessoaResponsavel, traducaoDe } from "@/lib/api/auth-dual-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { criarVersaoDoAgente } from "@/lib/ai/agents/administracao";

export const dynamic = "force-dynamic";

const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, cases_enabled, split_messages, split_max_chars, followup, operator_enabled, operator_model, operator_tool_ids, status, published_at, superseded_at, created_at, created_by,pipeline_ids,knowledge_source_ids,provisioning_origin";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "ai_agents",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;

  const supabase = authz.supabase;
  const { data, error } = await supabase
    .from("ai_agent_versions")
    .select(VERSION_COLUMNS)
    .eq("organization_id", authz.organizationId)
    .eq("agent_id", id)
    .order("version_number", { ascending: false });

  if (error) return fail("internal_error", "Erro ao listar versions.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

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
  const t = traducaoDe(authz);
  // `created_by` tem FK em auth.users: pessoa da sessão ou dono da chave (nunca o id do token).
  const responsavel = pessoaResponsavel(authz);
  if (!responsavel) return fail("forbidden", t("Não foi possível identificar quem responde por esta chave."), 403, { requestId });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  // Validação, escopo, credencial e o INSERT (com retentativa na corrida) vivem em
  // `lib/ai/agents/administracao.ts` — o MESMO das tools MCP. Roda UMA vez por `Idempotency-Key`.
  try {
    return await criarComChaveOpcional(req, authz, {
      requestId,
      endpoint: `/api/v1/ai/agents/${id}/versions`,
      corpo: raw,
      t,
      executar: () =>
        criarVersaoDoAgente(
          {
            supabase: authz.supabase,
            admin: createAdminClient(),
            organizationId: authz.organizationId,
            actor: authz.actor,
            responsavel,
            requestId,
          },
          id,
          raw,
        ),
    });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
