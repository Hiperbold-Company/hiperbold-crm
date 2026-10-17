import { requireSupportWrite } from "@/lib/impersonate/support";
import { isServiceRoleConfigured } from "@/lib/audit";
/**
 * POST /api/v1/team/invite — bulk-invite up to 20 emails.
 *
 * O que viaja no e-mail é um token HMAC stateless (`lib/auth/invite-token.ts`).
 * Quando o service-role está configurado, cada convite também vira uma linha em
 * `team_invites` (migration 0238) — é o que a tela de Equipe lista e o que
 * torna a revogação possível. Reconvidar um e-mail com convite pendente RENOVA
 * a linha. Sem service-role, degrada para só-token (nada some, só não persiste).
 *
 * Se o e-mail já tem membership ATIVA na org, pula com `already_member`.
 *
 * Membership row is created at /accept-invite time (Server Action) — that's
 * also when audit emits `member.accepted`. Here we audit `member.invited`.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/team/administracao.ts`, a mesma das tools MCP.
 * Auth: sessão OU token (`role:admin` + `mcp:write`). O convidante que fica gravado (`invited_by`) é a pessoa da
 * sessão ou o DONO do token; quem agiu de fato vai no audit (`actor_api_token_id`).
 *
 * Pelo TOKEN o convite sai só por e-mail: o link de aceite dá o papel convidado a quem o tiver, e uma chave de
 * integração não deve receber esse segredo na resposta (ficaria em log, fila e histórico de quem chamou). A
 * sessão segue recebendo o link — é o que a tela copia quando o e-mail não sai.
 */
import type { NextRequest } from "next/server";

import { nomeDaOrganizacao, nomeDeQuemAgiu } from "@/lib/api/auth-dual-admin";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { inviteMemberSchema, validateRequest } from "@/lib/schemas";
import { convidarMembros } from "@/lib/team/administracao";
import { entradaDeEquipe } from "@/lib/team/porta";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entradaDeEquipe(req);
  if (e.resposta) return e.resposta;
  if (!e.deps.responsavel) {
    return fail("forbidden", "Token sem dono ativo.", 403, { requestId: e.requestId });
  }

  let input;
  try {
    input = await validateRequest(inviteMemberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId: e.requestId,
      });
    }
    throw err;
  }

  try {
    const resultado = await convidarMembros(e.deps, input, {
      orgName: await nomeDaOrganizacao(e.authz),
      inviterName: await nomeDeQuemAgiu(e.authz),
      ocultarLink: e.authz.via === "token",
      comServiceRole: isServiceRoleConfigured(),
    });
    return ok(resultado, { status: 201, requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
