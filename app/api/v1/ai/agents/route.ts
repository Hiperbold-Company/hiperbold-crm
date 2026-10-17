import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/agents  — list agents da org ativa (manager+).
 *                            Inclui kind, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at,
 *                            e o provider/model da VERSÃO PUBLICADA (ver abaixo).
 *                            Filtro `?include_archived=true` opcional.
 * POST /api/v1/ai/agents  — create agent (admin).
 *                            Mode A (legacy rag_bot): body sem `version` → cria agent
 *                              kind='rag_bot' (mantém compat com Spec 05 / EPIC-06).
 *                            Mode B (mcp_agent S-13.06): body com `version` → cria
 *                              agent kind='mcp_agent' + ai_agent_versions v1 draft
 *                              numa sequência ordenada (rollback se versão falhar).
 *
 * Auth: sessão OU token `dsk_…` (`role:manager`+ para ler, `role:admin` para criar; `mcp:read` /
 * `mcp:write`). organization_id vem da sessão/da linha do token — nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { criarComChaveOpcional } from "@/lib/api/criacao-idempotente";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { ok, fail } from "@/lib/api/wrappers";
import { autorizarAdministracao, pessoaResponsavel, traducaoDe } from "@/lib/api/auth-dual-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { criarAgenteMcp, listarAgentes } from "@/lib/ai/agents/administracao";
import { agentCreateSchema } from "@/lib/ai/guardrails-schema";

export const dynamic = "force-dynamic";

const AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "ai_agents",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;

  const includeArchived = req.nextUrl.searchParams.get("include_archived") === "true";

  try {
    return ok(
      await listarAgentes(
        {
          supabase: authz.supabase,
          admin: createAdminClient(),
          organizationId: authz.organizationId,
          actor: authz.actor,
          responsavel: pessoaResponsavel(authz),
          requestId,
        },
        { incluirArquivados: includeArchived },
      ),
      { requestId },
    );
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

// ---------------------------------------------------------------------------
// POST — create
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const wantsMcp =
    typeof rawBody === "object" &&
    rawBody !== null &&
    ("version" in rawBody || (rawBody as { kind?: unknown }).kind === "mcp_agent");

  const admin = createAdminClient();

  if (wantsMcp) {
    // Agente `mcp_agent` + versão 1 em rascunho: o efeito vive em `lib/ai/agents/administracao.ts`
    // (o MESMO das tools MCP) e roda UMA vez por `Idempotency-Key`.
    try {
      return await criarComChaveOpcional(req, authz, {
        requestId,
        endpoint: "/api/v1/ai/agents",
        corpo: rawBody,
        t,
        executar: () =>
          criarAgenteMcp(
            { supabase: authz.supabase, admin, organizationId: authz.organizationId, actor: authz.actor, responsavel, requestId },
            rawBody,
          ),
      });
    } catch (err) {
      return respostaDeRecusa(err, requestId);
    }
  }

  // Legacy path — kind='rag_bot' (default DB constraint).
  const parsed = agentCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const { data, error } = await admin
    .from("ai_agents")
    .insert({
      organization_id: authz.organizationId,
      name: input.name,
      description: input.description ?? null,
      model: input.model ?? "anthropic/claude-sonnet-5",
      system_prompt: input.system_prompt,
      is_active: true,
      is_default: false,
      created_by: responsavel,
    })
    .select(AGENT_COLUMNS)
    .single();

  if (error || !data) {
    return fail("internal_error", "Erro ao criar agent.", 500, { requestId });
  }
  return ok(data, { status: 201, requestId });
}
