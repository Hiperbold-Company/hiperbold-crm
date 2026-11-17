import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/conversations/[id]/scheduled-messages — as agendadas que a conversa mostra.
 * POST /api/v1/conversations/[id]/scheduled-messages — agenda uma mensagem (migration 1017).
 *
 * Quem envia na hora marcada é o cron `mensagens-agendadas`, pela MESMA porta de
 * envio do compositor (`sendMessageHandler`). Aqui só se grava a intenção, com as
 * checagens que dá para fazer agora: a conversa é visível para quem pede (RLS da
 * sessão), o horário é futuro e, se a janela de 24h estará fechada no horário,
 * há um modelo aprovado escolhido. A organização vem da sessão, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia, identidadeDoAtor } from "@/lib/api/idempotency";
import { fail, falhaInterna, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { criarAgendadaSchema } from "@/lib/mensagens-agendadas/schema";
import {
  conferirAgendamento,
  inserirAgendada,
  lerConversaDoAgendamento,
  listarAgendadasDaConversa,
  type LinhaDaAgendada,
} from "@/lib/mensagens-agendadas/servidor";
import { exigirPermissao } from "@/lib/permissoes/servidor";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ENDPOINT = "POST /api/v1/conversations/:id/scheduled-messages";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const servico = createAdminClient();
  const conversa = await lerConversaDoAgendamento(await createClient(), servico, authz.org.orgId, id);
  if (!conversa.ok) return falhaInterna("internal_error", conversa.erro, { requestId });
  if (!conversa.valor) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const lista = await listarAgendadasDaConversa(servico, authz.org.orgId, id);
  if (!lista.ok) return falhaInterna("internal_error", lista.erro, { requestId });
  return ok(lista.valor, { requestId });
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Agendar é responder mais tarde: a mesma capacidade do compositor.
  const authz = await exigirPermissao("chat.responder", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const raw = await req.json().catch(() => null);
  const parsed = criarAgendadaSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const input = parsed.data;

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", t("Idempotency-Key deve ser UUID"), 400, { requestId });
  }

  const servico = createAdminClient();
  const conversa = await lerConversaDoAgendamento(await createClient(), servico, org.orgId, id);
  if (!conversa.ok) return falhaInterna("internal_error", conversa.erro, { requestId });
  if (!conversa.valor) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const agora = new Date();
  const sendAt = new Date(input.send_at);
  const modelo = input.template ?? null;
  const recusa = conferirAgendamento(conversa.valor, sendAt, modelo, agora);
  if (recusa) return fail(recusa.codigo, t(recusa.mensagem), 422, { requestId });

  const executar = async (): Promise<{ resposta: LinhaDaAgendada; status: number }> => {
    const gravada = await inserirAgendada(servico, {
      organizationId: org.orgId,
      userId: user.id,
      conversa: conversa.valor!,
      body: input.body,
      sendAt,
      modelo,
      agora,
    });
    if (!gravada.ok) throw gravada.erro;
    void audit({
      action: "scheduled_message.created",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "scheduled_message",
      resourceId: gravada.valor.id,
      requestId,
      // Sem o texto: o audit diz o que aconteceu, não guarda a conversa.
      metadata: { conversation_id: id, send_at: gravada.valor.send_at, com_modelo: modelo !== null },
    });
    return { resposta: gravada.valor, status: 201 };
  };

  try {
    const desfecho =
      chave === null
        ? { tipo: "executou" as const, ...(await executar()) }
        : await comIdempotencia<LinhaDaAgendada>({
            db: servico,
            organizationId: org.orgId,
            endpoint: ENDPOINT,
            chave,
            ator: identidadeDoAtor({ type: "user", id: user.id }),
            corpo: { conversation_id: id, ...input },
            executar,
          });
    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );
    }
    return ok(desfecho.resposta, { status: 201, requestId });
  } catch (erro) {
    return falhaInterna("internal_error", erro, { requestId });
  }
}
