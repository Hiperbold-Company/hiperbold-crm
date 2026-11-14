/**
 * Ação "Atribuir a conversa e iniciar o atendimento" (`assign_conversation`).
 *
 * A troca de dono é a MESMA do botão "Transferir" da Inbox: a função
 * `fn_conversation_assign` faz, na mesma transação, o `UPDATE` do dono, o
 * evento em `conversation_assignment_events` e — por ser destino humano — a
 * trava do atendimento automático (`bot_silenced_until = infinity`). Nada
 * daquela regra é reescrito aqui; só se escolhe a conversa e se confere a
 * pessoa. Depois da troca entram os mesmos rastros da rota de transferência:
 * auditoria, evento do barramento (a notificação do destino) e a linha na
 * linha do tempo da conversa.
 *
 * Qual conversa: a mais recente do contato (e dos gêmeos de telefone) NO CANAL
 * DO GATILHO (`vars.gatilho.channel_session_id`); sem conversa ali, a mais
 * recente do contato. Só entram conversas NÃO fechadas (`closed`, `archived` e
 * `resolved` ficam de fora: atribuir reabriria o atendimento). Sem nenhuma, erro
 * `sem_conversa` — a saída "Erro" do bloco, nunca uma exceção.
 *
 * Contato pessoal (`contacts.is_personal`, spec 21) não recebe atendimento: se o
 * contato ou um gêmeo de telefone for pessoal, erro `contato_pessoal`.
 *
 * ⚠️ Service role: organização vem da INSCRIÇÃO (`c.org`), nunca do grafo; a
 * pessoa é conferida no banco como membro ativo desta organização e toda
 * consulta filtra `organization_id`.
 */
import { audit } from "@/lib/audit";
import { idsDoContatoEGemeos } from "@/lib/channels/contato-por-telefone";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { sincronizarNegocioAbertoDoContato } from "@/lib/inbox/negocio-aberto-do-contato";

import type { CrmAction } from "../schemas";
import type { Contexto, Passo } from "./index";

type Atribuir = Extract<CrmAction, { type: "assign_conversation" }>;

/** Texto da linha do tempo: o mesmo da transferência manual (já traduzido no dicionário). */
export const MOTIVO_DA_ATRIBUICAO = "Transferiu a conversa para outro atendente";

function canalDoGatilho(vars: Record<string, unknown> | undefined): string | null {
  const g = vars?.gatilho;
  if (!g || typeof g !== "object") return null;
  const id = (g as Record<string, unknown>).channel_session_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Status de conversa que contam como encerrada: atribuir ali reabriria o atendimento. */
const STATUS_FECHADOS = "(closed,archived,resolved)";

type Alvo = { id: string; assigned_to_user_id: string | null; channel_session_id: string | null };
type Escolha = { conversa: Alvo | null; pessoal: boolean };

/** A conversa a atribuir: a mais recente (não fechada) no canal do gatilho; senão, a mais recente do contato. */
async function conversaAAtribuir(c: Contexto): Promise<Escolha> {
  const ids = await idsDoContatoEGemeos(c.admin, c.org, c.contatoId);
  if (ids.length === 0) return { conversa: null, pessoal: false };
  // Pessoal some do atendimento (spec 21): o contato ou qualquer gêmeo basta.
  const { data: pessoais, error: erroPessoal } = await c.admin
    .from("contacts")
    .select("id")
    .eq("organization_id", c.org)
    .in("id", [...ids])
    .eq("is_personal", true)
    .limit(1);
  if (erroPessoal) throw new Error("conversa_indeterminada");
  if ((pessoais ?? []).length > 0) return { conversa: null, pessoal: true };
  const { data, error } = await c.admin
    .from("conversations")
    .select("id, channel_session_id, assigned_to_user_id, last_message_at")
    .eq("organization_id", c.org)
    .in("contact_id", [...ids])
    .eq("is_group", false)
    .not("status", "in", STATUS_FECHADOS)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(20);
  if (error) throw new Error("conversa_indeterminada");
  const linhas = (data ?? []) as Alvo[];
  const canal = canalDoGatilho(c.vars ?? c.fatos?.vars);
  const doCanal = canal ? linhas.find((l) => l.channel_session_id === canal) : undefined;
  return { conversa: doCanal ?? linhas[0] ?? null, pessoal: false };
}

export async function executarAtribuirConversa(
  c: Contexto,
  acao: Atribuir,
  /** Membro ativo (e não só visualizador) desta organização — a régua dos outros efeitos de pessoa. */
  membroAtivo: (c: Contexto, userId: string) => Promise<boolean>,
): Promise<Passo> {
  const base = { tipo: acao.type };
  if (!(await membroAtivo(c, acao.user_id))) return { ok: false, erro: "usuario_invalido", detalhe: base };

  const { conversa: alvo, pessoal } = await conversaAAtribuir(c);
  if (pessoal) return { ok: false, erro: "contato_pessoal", detalhe: base };
  if (!alvo) return { ok: false, erro: "sem_conversa", detalhe: base };
  const conversaId = alvo.id;
  // Copiados ANTES da troca: é o "de onde veio" da auditoria.
  const donoAnterior = alvo.assigned_to_user_id;
  const numeroAnterior = alvo.channel_session_id;

  const { data, error } = await c.admin.rpc("fn_conversation_assign", {
    p_organization_id: c.org,
    p_conversation_id: conversaId,
    p_to_user_id: acao.user_id,
    p_reason: "transfer",
    // Imediata, como a transferência manual: reatribui qualquer que seja o dono atual.
    p_enforce_expected: false,
  });
  if (error) {
    // A função recusa quem não é atendente da organização; é o mesmo caso de `membroAtivo`.
    const recusada = /assignee_not_eligible_member/.test(error.message ?? "");
    return { ok: false, erro: recusada ? "usuario_invalido" : "efeito_falhou", detalhe: base };
  }
  const conversa = (
    data as Array<{
      id: string;
      organization_id: string;
      contact_id: string | null;
      channel_session_id?: string | null;
    }> | null
  )?.[0];
  if (!conversa) return { ok: false, erro: "sem_conversa", detalhe: base };

  // O negócio aberto do contato segue o atendente, como na transferência manual.
  // Tolerado: a troca de dono já aconteceu; o motivo vai para a auditoria.
  const sincronia = await sincronizarNegocioAbertoDoContato(c.admin, {
    organizationId: c.org,
    contactId: conversa.contact_id ?? c.contatoId,
    toUserId: acao.user_id,
  });
  // O número segue o vendedor (#3642): a função pode trocar o canal da conversa.
  const numeroNovo = conversa.channel_session_id !== undefined ? conversa.channel_session_id : numeroAnterior;

  await audit({
    action: "conversation.transferred",
    actorUserId: null,
    organizationId: c.org,
    resourceType: "conversation",
    resourceId: conversa.id,
    requestId: c.handler.requestId,
    metadata: {
      actor_type: "webhook_source",
      actor_id: c.pointerId,
      origem: "automacao",
      to_user_id: acao.user_id,
      from_user_id: donoAnterior,
      numero_anterior: numeroAnterior,
      numero_novo: numeroNovo,
      negocio_aberto: sincronia.motivo,
      ...(sincronia.leadId ? { negocio_id: sincronia.leadId } : {}),
      ...(c.versionId ? { version_id: c.versionId } : {}),
    },
  });

  // O destino é avisado pelo barramento, como na transferência manual.
  const { error: erroEvento } = await c.admin.rpc("emit_event", {
    p_event_type: "conversation.transferred",
    p_entity_kind: "conversation",
    p_entity_id: conversa.id,
    p_payload: { assigned_to_user_id: acao.user_id, transferred_by: null },
    p_metadata: {
      request_id: c.handler.requestId,
      caused_by_automation: { pointer_id: c.pointerId, enrollment_id: c.enrollmentId },
    },
    p_organization_id: c.org,
  });
  void erroEvento; // o aviso é tolerado: a troca de dono já aconteceu e não se desfaz.

  await registrarTrocaDeComando({
    supabase: c.admin,
    organizationId: c.org,
    conversationId: conversa.id,
    contactId: conversa.contact_id ?? c.contatoId,
    tipo: "conversation_transferred",
    actor: c.handler.actor,
    motivo: MOTIVO_DA_ATRIBUICAO,
    payload: { to_user_id: acao.user_id, origem: "automacao", pointer_id: c.pointerId },
  });

  return { ok: true, detalhe: { ...base, conversation_id: conversa.id, user_id: acao.user_id } };
}
