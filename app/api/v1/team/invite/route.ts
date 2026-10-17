import type { EmailDeliveryError } from "@/lib/email/roteador";
import { recusaSeEmailNaoVerificado } from "@/lib/auth/exigir-email-verificado";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { issueInvite } from "@/lib/auth/issue-invite";
import { emitirConvite } from "@/lib/team/convites";
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
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";

import { recusaDoPlano } from "@/lib/billing/planos/recusa-do-plano";
import {
  atorDoAudit,
  gastarVagaDeConvite,
  haVagaDeConviteNaHora,
  autorizarAdministracao,
  nomeDaOrganizacao,
  nomeDeQuemAgiu,
  pessoaResponsavel,
  traducaoDe,
} from "@/lib/api/auth-dual-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { inviteMemberSchema, validateRequest } from "@/lib/schemas";

export const dynamic = "force-dynamic";

interface SentItem {
  email: string;
  invite_id: string;
  expires_at: string;
  email_dispatched: boolean;
  /** Por que não saiu, quando não saiu. Vocabulário de `lib/email/roteador.ts`. */
  email_error?: EmailDeliveryError;
  accept_url: string;
}
interface FailedItem {
  email: string;
  reason: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Sessão OU token (`role:admin` + `mcp:write`). O convidante que fica gravado
  // (`invited_by`) é a pessoa da sessão ou o DONO do token; quem agiu de fato
  // vai no audit (`actor_api_token_id`).
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "team",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const convidanteId = pessoaResponsavel(authz);
  if (!convidanteId) {
    return fail("forbidden", "Token sem dono ativo.", 403, { requestId });
  }
  // D-204: convidar é criar acesso que sobrevive à retomada da conta; exige o e-mail de quem convida provado.
  const naoVerificado = await recusaSeEmailNaoVerificado({
    userId: convidanteId,
    frase: traducaoDe(authz)("Confirme seu e-mail para convidar pessoas."),
    requestId,
  });
  if (naoVerificado) return naoVerificado;
  const activeOrg = { orgId: authz.organizationId, name: await nomeDaOrganizacao(authz) };
  const ator = atorDoAudit(authz);

  let input;
  try {
    input = await validateRequest(inviteMemberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const sent: SentItem[] = [];
  const failed: FailedItem[] = [];

  const admin = isServiceRoleConfigured() ? createAdminClient() : null;
  const inviterName = await nomeDeQuemAgiu(authz);
  // Emails com membership ATIVA na org — para pular o reconvite de quem já é membro.
  // O schema `auth` NÃO é acessível via PostgREST (erro "Invalid schema: auth"), então
  // resolvemos email↔usuário pela GoTrue admin API (getUserById) — mesmo padrão de
  // app/api/v1/team/route.ts. N pequeno (poucos membros por org no perfil BPO).
  const memberEmails = new Set<string>();
  if (admin) {
    const { data: members } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", activeOrg.orgId)
      .is("revoked_at", null);
    for (const m of members ?? []) {
      const { data: u } = await admin.auth.admin.getUserById(m.user_id as string);
      const memberEmail = u?.user?.email?.trim().toLowerCase();
      if (memberEmail) memberEmails.add(memberEmail);
    }
  }

  for (const inv of input.invitations) {
    const email = inv.email.trim().toLowerCase();

    // Teto por organização (qualquer porta): cada e-mail novo gasta uma vaga da hora.
    if (!memberEmails.has(email) && !(await haVagaDeConviteNaHora(activeOrg.orgId))) {
      failed.push({ email, reason: "rate_limited" });
      continue;
    }

    // já é membro ativo → pula (não reenvia convite)
    if (memberEmails.has(email)) {
      failed.push({ email, reason: "already_member" });
      continue;
    }

    if (admin) {
      let emitido;
      try {
        emitido = await emitirConvite(admin, {
          email,
          role: inv.role,
          interfaceSettings: inv.interface_settings,
          organizationId: activeOrg.orgId,
          orgName: activeOrg.name,
          inviterId: convidanteId,
          actorApiTokenId: ator.actorApiTokenId,
          inviterName,
          requestId,
        });
      } catch (err) {
        // Fase F3, decisão 4 (item 1 — convite novo/renovado bloqueia, sem
        // isenção): este é um LOTE de até 20 e-mails, então um convite acima
        // do teto vira UMA falha do item, e o resto do lote segue (mesmo
        // contrato de `already_member`) — não aborta a requisição inteira.
        // Qualquer outro erro segue sendo defeito de programação: propaga.
        const recusa = recusaDoPlano(err);
        if (recusa) {
          failed.push({ email, reason: recusa.mensagem });
          continue;
        }
        throw err;
      }
      await gastarVagaDeConvite(activeOrg.orgId);
      const { convite, accept_url, email_dispatched, email_error } = emitido;
      sent.push({
        email,
        invite_id: convite.id,
        expires_at: convite.expires_at,
        email_dispatched,
        email_error,
        accept_url,
      });
    } else {
      await gastarVagaDeConvite(activeOrg.orgId);
      sent.push(
        await issueInvite({
          email,
          role: inv.role,
          interfaceSettings: inv.interface_settings,
          organizationId: activeOrg.orgId,
          orgName: activeOrg.name,
          inviterId: convidanteId,
          actorApiTokenId: ator.actorApiTokenId,
          inviterName,
          requestId,
        }),
      );
    }
  }

  // Pelo TOKEN o convite sai só por e-mail: o link de aceite dá o papel convidado a
  // quem o tiver, e uma chave de integração não deve receber esse segredo na
  // resposta (ficaria em log, fila e histórico de quem chamou). A sessão segue
  // recebendo o link — é o que a tela copia quando o e-mail não sai.
  const sentVisivel = authz.via === "token" ? sent.map(({ accept_url: _link, ...resto }) => resto) : sent;
  return ok({ sent: sentVisivel, failed }, { status: 201, requestId });
}
