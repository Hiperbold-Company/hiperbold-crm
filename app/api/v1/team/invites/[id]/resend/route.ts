/**
 * POST /api/v1/team/invites/[id]/resend — reenvia um convite pendente.
 *
 * admin-only. Re-assina o token com o mesmo `invite_id`, dispara o e-mail de
 * novo e renova a validade (24h a partir de agora). Audita `member.invited`
 * pelo admin que clicou — é uma nova emissão do mesmo convite.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { recusaSeEmailNaoVerificado } from "@/lib/auth/exigir-email-verificado";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { recusaDoPlano, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import {
  atorDoAudit,
  cabeConviteNaHora,
  podeReenviarConvite,
  autorizarAdministracao,
  nomeDaOrganizacao,
  nomeDeQuemAgiu,
  pessoaResponsavel,
  traducaoDe,
} from "@/lib/api/auth-dual-admin";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { reenviarConvite, statusConvite, type ConviteDeTime } from "@/lib/team/convites";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  // Sessão OU token (`role:admin` + `mcp:write`); org do token vem da linha dele.
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "team",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);
  const ator = atorDoAudit(authz);

  // D-204: reenviar renova um convite com link novo; mesma trava de `POST /team/invite`.
  const naoVerificado = await recusaSeEmailNaoVerificado({
    userId: pessoaResponsavel(authz),
    frase: t("Confirme seu e-mail para convidar pessoas."),
    requestId,
  });
  if (naoVerificado) return naoVerificado;
  const activeOrg = { orgId: authz.organizationId, name: await nomeDaOrganizacao(authz) };
  const responsavelId = pessoaResponsavel(authz);
  if (!responsavelId) return fail("forbidden", "Token sem dono ativo.", 403, { requestId });

  if (!z.string().uuid().safeParse(id).success) {
    return fail("invalid_request", t("Convite inválido."), 400, { requestId });
  }
  if (!isServiceRoleConfigured()) {
    return fail("unavailable", t("Envio de e-mail não configurado nesta instalação."), 503, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const { data: row, error: readErr } = await admin
    .from("team_invites")
    .select(
      "id, organization_id, email, role, interface_settings, invited_by, inviter_name, email_dispatched, created_at, last_sent_at, resend_count, expires_at, accepted_at, revoked_at",
    )
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (readErr) return falhaInterna("internal_error", readErr, { requestId });
  if (!row) return fail("not_found", t("Convite não encontrado."), 404, { requestId });

  const convite = row as ConviteDeTime;
  const status = statusConvite(convite);
  if (status === "aceito") {
    return fail("state_conflict", t("Este convite já foi aceito."), 409, { requestId });
  }
  if (status === "revogado") {
    return fail("state_conflict", t("Este convite foi revogado. Envie um novo."), 409, {
      requestId,
    });
  }

  // Teto por organização, por qualquer porta: no mínimo 10 min entre dois reenvios
  // do MESMO convite, e o reenvio também gasta uma vaga da hora de e-mails.
  if (!(await podeReenviarConvite(activeOrg.orgId, id)) || !(await cabeConviteNaHora(activeOrg.orgId))) {
    return fail(
      "rate_limited",
      t("Este convite foi reenviado há pouco. Aguarde alguns minutos para reenviar de novo."),
      429,
      { requestId, headers: { "Retry-After": "600" } },
    );
  }

  let resultado;
  try {
    resultado = await reenviarConvite(admin, {
      convite,
      orgName: activeOrg.name,
      actorId: responsavelId,
      actorName: await nomeDeQuemAgiu(authz),
      actorApiTokenId: ator.actorApiTokenId,
      requestId,
    });
  } catch (err) {
    // Fase F3, decisão 4 (item 1): renovar um convite VENCIDO volta a ocupar
    // vaga de membro (achado B1 da 0905) — bloqueia igual, sem isenção.
    const recusa = recusaDoPlano(err);
    if (recusa) return fail("plano_limite_atingido", recusa.mensagem, STATUS_RECUSA_DO_PLANO, { requestId });
    throw err;
  }
  if (!resultado) {
    return fail("state_conflict", t("O convite mudou. Atualize e tente de novo."), 409, {
      requestId,
    });
  }

  return ok(
    {
      ...resultado.convite,
      status: statusConvite(resultado.convite),
      // Pelo TOKEN o link de aceite não volta (o convite só vale pelo e-mail).
      accept_url: authz.via === "token" ? null : resultado.accept_url,
      email_dispatched: resultado.email_dispatched,
    },
    { requestId },
  );
}
