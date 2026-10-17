/**
 * ADMINISTRAR a equipe pela API — convidar (lote), mudar papel, revogar e reativar acesso.
 *
 * Quem chama: as rotas `/api/v1/team/**` (sessão OU token `dsk_…`) e as tools MCP de administração
 * (`lib/mcp/tools/administracao-equipe.ts`). A regra é uma só: duas implementações de "revogar" divergem
 * no primeiro efeito colateral novo (as chaves de API do membro, as inscrições de push, as conversas abertas).
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere `admin` + `mcp:write` (o piso da tela) e entrega a
 * organização já resolvida. O cliente `admin` é service role e BYPASSA a RLS: todo SELECT/UPDATE leva
 * `organization_id` explícito. O papel e o vínculo só são gravados pelo servidor (migration 0929, D-125).
 *
 * ⚠️ `responsavel` é a PESSOA (FK em auth.users): o usuário da sessão ou o DONO da chave. Uma chave não
 * revoga o acesso do seu dono (ela morre junto com ele, D-101), e convida em nome dele.
 *
 * ⚠️ O LINK DE ACEITE NUNCA VAI PARA UMA CHAVE: ele dá o papel convidado a quem o tiver, e uma chave de
 * integração não deve guardá-lo (log, fila, histórico de quem chamou). Pelo token o convite sai só por e-mail.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { issueInvite } from "@/lib/auth/issue-invite";
import { recusaDoPlano, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import {
  gastarVagaDeConvite,
  haVagaDeConviteNaHora,
} from "@/lib/api/auth-dual-admin";
import type { EmailDeliveryError } from "@/lib/email/roteador";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { logger } from "@/lib/logger";
import type { InterfaceSettings } from "@/lib/navigation/interface";
import { emitirConvite } from "@/lib/team/convites";
import type { Role } from "@/lib/schemas/team";

export interface DepsDeEquipe {
  /** Leitura: o cliente da sessão (RLS) ou o de servidor do token — ambos com filtro de organização. */
  supabase: SupabaseClient;
  /** Service role: grava vínculo, chaves, push; lê a GoTrue. Nunca sem `organization_id` explícito. */
  admin: SupabaseClient;
  organizationId: string;
  actor: Actor;
  /** Pessoa responsável (FK em auth.users): usuário da sessão ou dono da chave. */
  responsavel: string | null;
  requestId: string;
  t?: (texto: string) => string;
}

const tr = (deps: DepsDeEquipe) => deps.t ?? ((texto: string) => texto);

function recusa(deps: DepsDeEquipe, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, deps.requestId, message);
}

function falhaInterna(deps: DepsDeEquipe, erro: unknown): ApiError {
  const causa =
    erro instanceof Error
      ? erro.message
      : erro && typeof erro === "object" && typeof (erro as { message?: unknown }).message === "string"
        ? (erro as { message: string }).message
        : "desconhecido";
  logger.error("api.falha_interna", { code: "internal_error", request_id: deps.requestId, causa });
  return recusa(deps, 500, "internal_error", MENSAGEM_DE_FALHA_INTERNA);
}

interface Alvo {
  id: string;
  user_id: string;
  role: string;
  revoked_at: string | null;
}

async function membroDaOrganizacao(deps: DepsDeEquipe, userId: string): Promise<Alvo> {
  const { data: target, error } = await deps.supabase
    .from("user_organizations")
    .select("id, user_id, role, revoked_at")
    .eq("organization_id", deps.organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw falhaInterna(deps, error);
  if (!target) throw recusa(deps, 404, "not_found", tr(deps)("Membro não encontrado."));
  return target as unknown as Alvo;
}

async function adminsAtivos(deps: DepsDeEquipe): Promise<number> {
  const { count, error } = await deps.supabase
    .from("user_organizations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", deps.organizationId)
    .eq("role", "admin")
    .is("revoked_at", null);
  if (error) throw falhaInterna(deps, error);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// mudar papel
// ---------------------------------------------------------------------------

/** Não rebaixa o último admin; não mexe em membro revogado. */
export async function mudarPapelDoMembro(
  deps: DepsDeEquipe,
  userId: string,
  novoPapel: Role,
): Promise<{ user_id: string; role: Role }> {
  const t = tr(deps);
  const target = await membroDaOrganizacao(deps, userId);
  if (target.revoked_at) throw recusa(deps, 409, "state_conflict", t("Membro está revogado."));

  if (target.role === "admin" && novoPapel !== "admin" && (await adminsAtivos(deps)) <= 1) {
    throw recusa(deps, 409, "state_conflict", t("Não é possível rebaixar o último admin do tenant."));
  }

  // O papel só é gravado pelo servidor (migration 0929, D-125). O banco recusa deixar a organização sem admin.
  const { error } = await deps.admin
    .from("user_organizations")
    .update({ role: novoPapel, updated_at: new Date().toISOString() })
    .eq("id", target.id)
    .eq("organization_id", deps.organizationId);
  if (error) {
    if (error.message.includes("organizacao_sem_admin")) {
      throw recusa(deps, 409, "state_conflict", t("Não é possível rebaixar o último admin do tenant."));
    }
    throw falhaInterna(deps, error);
  }

  await audit({
    action: "team.role_changed",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "membership",
    resourceId: target.id,
    requestId: deps.requestId,
    metadata: { target_user_id: userId, old_role: target.role, new_role: novoPapel },
  });
  return { user_id: userId, role: novoPapel };
}

// ---------------------------------------------------------------------------
// revogar / reativar
// ---------------------------------------------------------------------------

/**
 * Tira o acesso. Ninguém revoga o próprio acesso (e a chave não revoga o do dono). As chaves de API do membro e as
 * inscrições de push saem junto; as conversas abertas dele voltam para a fila.
 */
export async function revogarAcessoDoMembro(
  deps: DepsDeEquipe,
  userId: string,
): Promise<{ user_id: string; revoked_at?: string; already_revoked?: true }> {
  const t = tr(deps);
  if (deps.responsavel && userId === deps.responsavel) {
    throw recusa(deps, 409, "state_conflict", t("Não é possível revogar o próprio acesso."));
  }
  const target = await membroDaOrganizacao(deps, userId);
  if (target.revoked_at) return { user_id: userId, already_revoked: true };

  if (target.role === "admin" && (await adminsAtivos(deps)) <= 1) {
    throw recusa(deps, 409, "state_conflict", t("Não é possível revogar o último admin do tenant."));
  }

  // Conversas abertas atribuídas a quem está saindo — o trigger do banco desatribui para a fila e esta função
  // grava a linha do tempo e o audit de liberação de cada uma (#1562).
  const { data: openConvs } = await deps.supabase
    .from("conversations")
    .select("id, contact_id")
    .eq("organization_id", deps.organizationId)
    .eq("assigned_to_user_id", userId)
    .in("status", ["open", "pending", "claimed", "ai_handling"]);

  const nowIso = new Date().toISOString();
  // O banco recusa tirar o último admin, também sob duas revogações ao mesmo tempo.
  const { error: updErr } = await deps.admin
    .from("user_organizations")
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq("id", target.id)
    .eq("organization_id", deps.organizationId);
  if (updErr) {
    if (updErr.message.includes("organizacao_sem_admin")) {
      throw recusa(deps, 409, "state_conflict", t("Não é possível revogar o último admin do tenant."));
    }
    throw falhaInterna(deps, updErr);
  }

  const ator = colunasDeAtorNoAudit(deps.actor);

  // As chaves de API que ele criou saem junto (D-101). Falha aqui não desfaz a revogação: o log avisa e o vínculo
  // já barra. `api_tokens` só é escrita pelo servidor (migration 0962).
  const { data: chavesRevogadas, error: chavesErr } = await deps.admin
    .from("api_tokens")
    .update({ revoked_at: nowIso, revoked_by: deps.responsavel, updated_at: nowIso })
    .eq("organization_id", deps.organizationId)
    .eq("created_by", userId)
    .is("revoked_at", null)
    .select("id");
  if (chavesErr) {
    logger.error("[team.revoke] revogar chaves do membro falhou", {
      org_id: deps.organizationId,
      target_user_id: userId,
      message: chavesErr.message,
    });
  }
  // As inscrições de push dele nesta organização também saem (D-097). Falha não desfaz a revogação.
  const { error: pushErr } = await deps.admin
    .from("push_subscriptions")
    .delete()
    .eq("organization_id", deps.organizationId)
    .eq("user_id", userId);
  if (pushErr) {
    logger.error("[team.revoke] apagar inscrições de push do membro falhou", {
      org_id: deps.organizationId,
      target_user_id: userId,
      message: pushErr.message,
    });
  }
  for (const chave of (chavesRevogadas ?? []) as Array<{ id: string }>) {
    await audit({
      action: "token.revoked",
      ...ator,
      organizationId: deps.organizationId,
      resourceType: "api_token",
      resourceId: chave.id,
      requestId: deps.requestId,
      metadata: { reason: "member_revoked", target_user_id: userId },
    });
  }

  const liberadas = (openConvs ?? []) as Array<{ id: string; contact_id: string }>;
  for (const conv of liberadas) {
    await audit({
      action: "conversation.released",
      ...ator,
      organizationId: deps.organizationId,
      resourceType: "conversation",
      resourceId: conv.id,
      requestId: deps.requestId,
      metadata: { reason: "member_revoked", target_user_id: userId },
    });
    await registrarTrocaDeComando({
      supabase: deps.supabase,
      organizationId: deps.organizationId,
      conversationId: conv.id,
      contactId: conv.contact_id,
      tipo: "conversation_released",
      actor: deps.actor,
      motivo: "Atendente revogado da organização",
    });
  }

  await audit({
    action: "member.revoked",
    ...ator,
    organizationId: deps.organizationId,
    resourceType: "membership",
    resourceId: target.id,
    requestId: deps.requestId,
    metadata: { target_user_id: userId, revoked_role: target.role, released_conversations_count: liberadas.length },
  });
  return { user_id: userId, revoked_at: nowIso };
}

/** Desfaz a revogação, com o mesmo papel que a pessoa tinha (reativar não promove). Idempotente. */
export async function reativarAcessoDoMembro(
  deps: DepsDeEquipe,
  userId: string,
): Promise<{ user_id: string; reactivated_at?: string; already_active?: true }> {
  const target = await membroDaOrganizacao(deps, userId);
  if (!target.revoked_at) return { user_id: userId, already_active: true };

  const nowIso = new Date().toISOString();
  const { error: updErr } = await deps.admin
    .from("user_organizations")
    .update({ revoked_at: null, updated_at: nowIso })
    .eq("id", target.id)
    .eq("organization_id", deps.organizationId);
  if (updErr) {
    // Reativação pelo ADMIN é "vínculo direto", não aceite de convite: nenhuma isenção do gatilho de plano vale.
    const limite = recusaDoPlano(updErr);
    if (limite) throw recusa(deps, STATUS_RECUSA_DO_PLANO, "plano_limite_atingido", limite.mensagem);
    throw falhaInterna(deps, updErr);
  }

  await audit({
    action: "member.reactivated",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "membership",
    resourceId: target.id,
    requestId: deps.requestId,
    metadata: { target_user_id: userId, restored_role: target.role },
  });
  return { user_id: userId, reactivated_at: nowIso };
}

// ---------------------------------------------------------------------------
// convidar (lote)
// ---------------------------------------------------------------------------

export interface ConviteEnviado {
  email: string;
  invite_id: string;
  expires_at: string;
  email_dispatched: boolean;
  /** Por que não saiu, quando não saiu. Vocabulário de `lib/email/roteador.ts`. */
  email_error?: EmailDeliveryError;
  accept_url?: string;
}
export interface ConviteFalho {
  email: string;
  reason: string;
}

export interface PedidoDeConvite {
  invitations: Array<{ email: string; role: Role; interface_settings?: InterfaceSettings }>;
}

/**
 * Convida até 20 e-mails. O que viaja no e-mail é um token HMAC stateless; com service role, cada convite também
 * vira uma linha em `team_invites` (a tela de Equipe lista e a revogação precisa dela). Quem já é membro ativo é
 * pulado com `already_member`; acima do teto da hora, `rate_limited`; acima do teto do plano, a mensagem do plano.
 */
export async function convidarMembros(
  deps: DepsDeEquipe,
  pedido: PedidoDeConvite,
  contexto: {
    /** Nome da organização e de quem convida, para o texto do e-mail (resolvidos pela porta). */
    orgName: string;
    inviterName: string;
    /** `true` quando quem chama é uma chave: o link de aceite não volta na resposta. */
    ocultarLink: boolean;
    /** Sem service role configurado, o convite degrada para só-token. */
    comServiceRole: boolean;
  },
): Promise<{ sent: ConviteEnviado[]; failed: ConviteFalho[] }> {
  if (!deps.responsavel) throw recusa(deps, 403, "forbidden", "Token sem dono ativo.");
  const convidanteId = deps.responsavel;
  const ator = colunasDeAtorNoAudit(deps.actor);

  const sent: ConviteEnviado[] = [];
  const failed: ConviteFalho[] = [];

  // Emails com membership ATIVA na org — para pular o reconvite de quem já é membro. O schema `auth` não é
  // acessível via PostgREST: resolve-se email↔usuário pela GoTrue admin API.
  const memberEmails = new Set<string>();
  if (contexto.comServiceRole) {
    const { data: members } = await deps.admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", deps.organizationId)
      .is("revoked_at", null);
    for (const m of members ?? []) {
      const { data: u } = await deps.admin.auth.admin.getUserById(m.user_id as string);
      const memberEmail = u?.user?.email?.trim().toLowerCase();
      if (memberEmail) memberEmails.add(memberEmail);
    }
  }

  for (const inv of pedido.invitations) {
    const email = inv.email.trim().toLowerCase();

    // Teto por organização (qualquer porta): cada e-mail novo gasta uma vaga da hora.
    if (!memberEmails.has(email) && !(await haVagaDeConviteNaHora(deps.organizationId))) {
      failed.push({ email, reason: "rate_limited" });
      continue;
    }
    if (memberEmails.has(email)) {
      failed.push({ email, reason: "already_member" });
      continue;
    }

    if (contexto.comServiceRole) {
      let emitido;
      try {
        emitido = await emitirConvite(deps.admin, {
          email,
          role: inv.role,
          interfaceSettings: inv.interface_settings,
          organizationId: deps.organizationId,
          orgName: contexto.orgName,
          inviterId: convidanteId,
          actorApiTokenId: ator.actorApiTokenId,
          inviterName: contexto.inviterName,
          requestId: deps.requestId,
        });
      } catch (err) {
        // Fase F3, decisão 4: convite acima do teto do plano vira UMA falha do item, e o resto do lote segue.
        const limite = recusaDoPlano(err);
        if (limite) {
          failed.push({ email, reason: limite.mensagem });
          continue;
        }
        throw err;
      }
      await gastarVagaDeConvite(deps.organizationId);
      const { convite, accept_url, email_dispatched, email_error } = emitido;
      sent.push({
        email,
        invite_id: convite.id,
        expires_at: convite.expires_at,
        email_dispatched,
        email_error,
        ...(contexto.ocultarLink ? {} : { accept_url }),
      });
    } else {
      await gastarVagaDeConvite(deps.organizationId);
      const emitido = await issueInvite({
        email,
        role: inv.role,
        interfaceSettings: inv.interface_settings,
        organizationId: deps.organizationId,
        orgName: contexto.orgName,
        inviterId: convidanteId,
        actorApiTokenId: ator.actorApiTokenId,
        inviterName: contexto.inviterName,
        requestId: deps.requestId,
      });
      const { accept_url, ...resto } = emitido as ConviteEnviado & { accept_url: string };
      sent.push({ ...resto, ...(contexto.ocultarLink ? {} : { accept_url }) });
    }
  }
  return { sent, failed };
}
