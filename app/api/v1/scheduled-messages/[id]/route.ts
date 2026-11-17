import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/scheduled-messages/[id] — edita texto, horário ou modelo de uma agendada.
 * DELETE /api/v1/scheduled-messages/[id] — cancela (ou dispensa a que falhou antes de sair).
 *
 * Quem pode: quem agendou, ou gerente e acima. A mensagem sai em nome de quem
 * agendou; deixar outro atendente reescrevê-la seria pôr palavra na boca do colega.
 * E só na conversa que a pessoa enxerga (RLS da sessão).
 *
 * Editar exige o `updated_at` que a tela viu e só alcança linha `agendada`: se o
 * worker já reservou a linha (status `enviando`) ou outra aba mexeu nela, a
 * resposta é 409 e nada muda. A organização vem da sessão, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, falhaInterna, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import type { RoleCheck } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerModelo } from "@/lib/mensagens-agendadas/regras";
import { editarAgendadaSchema } from "@/lib/mensagens-agendadas/schema";
import {
  cancelarAgendada,
  conferirAgendamento,
  editarAgendada,
  lerAgendada,
  lerConversaDoAgendamento,
  type ConversaDoAgendamento,
  type LinhaDaAgendada,
} from "@/lib/mensagens-agendadas/servidor";
import { exigirPermissao } from "@/lib/permissoes/servidor";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const MENSAGEM_NAO_ENCONTRADA = "Mensagem agendada não encontrada.";
const MENSAGEM_SO_QUEM_AGENDOU = "Só quem agendou, ou um gerente, pode mudar esta mensagem.";
const MENSAGEM_MUDOU = "Esta mensagem agendada mudou ou já começou a ser enviada. Atualize a conversa e tente de novo.";

type Autorizado = Extract<RoleCheck, { ok: true }>;

type Carregada =
  | { ok: true; linha: LinhaDaAgendada; conversa: ConversaDoAgendamento }
  | { ok: false; response: Response };

/** A linha da organização, na conversa que esta pessoa enxerga, e que ela pode mudar. */
async function carregar(authz: Autorizado, id: string, requestId: string): Promise<Carregada> {
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const naoEncontrada = { ok: false as const, response: fail("not_found", t(MENSAGEM_NAO_ENCONTRADA), 404, { requestId }) };
  if (!z.string().uuid().safeParse(id).success) return naoEncontrada;

  const servico = createAdminClient();
  const lida = await lerAgendada(servico, authz.org.orgId, id);
  if (!lida.ok) return { ok: false, response: falhaInterna("internal_error", lida.erro, { requestId }) };
  if (!lida.valor) return naoEncontrada;

  const conversa = await lerConversaDoAgendamento(
    await createClient(),
    servico,
    authz.org.orgId,
    lida.valor.conversation_id,
  );
  if (!conversa.ok) return { ok: false, response: falhaInterna("internal_error", conversa.erro, { requestId }) };
  // Conversa que a pessoa não enxerga: a agendada dela também não existe para ela.
  if (!conversa.valor) return naoEncontrada;

  if (lida.valor.created_by !== authz.user.id && !roleAtLeast(authz.org.role, "manager")) {
    return { ok: false, response: fail("forbidden", t(MENSAGEM_SO_QUEM_AGENDOU), 403, { requestId }) };
  }
  return { ok: true, linha: lida.valor, conversa: conversa.valor };
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await exigirPermissao("chat.responder", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = editarAgendadaSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const input = parsed.data;

  const carregada = await carregar(authz, id, requestId);
  if (!carregada.ok) return carregada.response;
  const { linha, conversa } = carregada;
  if (linha.status !== "agendada") return fail("conflict", t(MENSAGEM_MUDOU), 409, { requestId });

  const agora = new Date();
  // A regra da janela vale para o resultado da edição: o horário e o modelo
  // que vão ficar, não só o que mudou.
  const sendAt = new Date(input.send_at ?? linha.send_at);
  const modelo = input.template !== undefined ? input.template : lerModelo(linha.template);
  // Sem trocar o horário, a hora gravada pode já ter passado (a linha espera a
  // janela de horário do canal abrir): só a regra do modelo se aplica.
  const recusa = conferirAgendamento(conversa, sendAt, modelo, agora, {
    conferirHorario: input.send_at !== undefined,
  });
  if (recusa) return fail(recusa.codigo, t(recusa.mensagem), 422, { requestId });

  const desfecho = await editarAgendada(createAdminClient(), {
    organizationId: authz.org.orgId,
    id: linha.id,
    vistoEm: input.expected_updated_at,
    patch: {
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.send_at !== undefined ? { send_at: sendAt.toISOString() } : {}),
      ...(input.template !== undefined ? { template: input.template } : {}),
    },
    agora,
  });
  if (desfecho.tipo === "erro") return falhaInterna("internal_error", desfecho.erro, { requestId });
  if (desfecho.tipo === "conflito") return fail("conflict", t(MENSAGEM_MUDOU), 409, { requestId });

  void audit({
    action: "scheduled_message.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "scheduled_message",
    resourceId: linha.id,
    requestId,
    metadata: {
      conversation_id: linha.conversation_id,
      campos: Object.keys(input).filter((k) => k !== "expected_updated_at"),
      send_at: desfecho.linha.send_at,
    },
  });
  return ok(desfecho.linha, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await exigirPermissao("chat.responder", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const carregada = await carregar(authz, id, requestId);
  if (!carregada.ok) return carregada.response;

  const desfecho = await cancelarAgendada(createAdminClient(), {
    organizationId: authz.org.orgId,
    id: carregada.linha.id,
    agora: new Date(),
  });
  if (desfecho.tipo === "erro") return falhaInterna("internal_error", desfecho.erro, { requestId });
  if (desfecho.tipo === "conflito") return fail("conflict", t(MENSAGEM_MUDOU), 409, { requestId });

  void audit({
    action: "scheduled_message.cancelled",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "scheduled_message",
    resourceId: carregada.linha.id,
    requestId,
    metadata: { conversation_id: carregada.linha.conversation_id, status_anterior: carregada.linha.status },
  });
  return ok(desfecho.linha, { requestId });
}
