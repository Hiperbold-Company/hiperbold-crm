import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/message-templates — lista as respostas prontas visíveis a quem chama: as
 *      compartilhadas da organização e, na sessão, as pessoais do próprio usuário. Uma chave de
 *      API (`Bearer dsk_…`) só enxerga as compartilhadas (não tem resposta pessoal).
 * POST /api/v1/message-templates — cria uma resposta pronta. `shared=true` grava owner_user_id
 *      null (compartilhada) e exige manager+; `shared=false` (default, só sessão) grava
 *      owner_user_id = user.id. Aceita `Idempotency-Key: <uuid>`.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/operacao/respostas-prontas.ts`, a mesma das tools MCP.
 *
 * Auth: sessão (agent+; compartilhada exige manager+, como a tela) OU token `dsk_…`: leitura
 * `agent` + `mcp:read`; escrita `manager` + `mcp:write`, sempre compartilhada. `organization_id`
 * sai da sessão/da linha do token.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { autorizarAdministracao, pessoaResponsavel, traducaoDe } from "@/lib/api/auth-dual-admin";
import { criarComChaveOpcional } from "@/lib/api/criacao-idempotente";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { criarRespostaPronta, listarRespostasProntas } from "@/lib/operacao/respostas-prontas";
import { createTemplateSchema } from "@/lib/schemas/templates";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "message_templates",
    role: "agent",
    escrita: false,
  });
  if (!authz.ok) return authz.response;
  try {
    return ok(
      await listarRespostasProntas({
        supabase: authz.supabase,
        organizationId: authz.organizationId,
        actor: authz.actor,
        requestId,
      }),
      { requestId },
    );
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "message_templates",
    role: "agent",
    // Chave de API só escreve resposta COMPARTILHADA, e isso é papel de gerente na tela.
    tokenRole: "manager",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  const raw = await req.json().catch(() => null);
  const parsed = createTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  try {
    return await criarComChaveOpcional(req, authz, {
      requestId,
      endpoint: "/api/v1/message-templates",
      corpo: parsed.data,
      t,
      executar: () =>
        criarRespostaPronta(
          {
            supabase: authz.supabase,
            organizationId: authz.organizationId,
            actor: authz.actor,
            requestId,
          },
          parsed.data,
          pessoaResponsavel(authz),
        ),
    });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
