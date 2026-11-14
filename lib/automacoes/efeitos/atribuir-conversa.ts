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
 * Com `todas`, todas as conversas não fechadas do contato e dos gêmeos (até 20;
 * passou disso, `detalhe.truncado`). A PRINCIPAL — a que o modo sem `todas`
 * escolheria — vai primeiro e é atribuída sempre. As DEMAIS só entram quando a
 * IA não está no comando delas: é a régua da troca de carteira em lote ("Doc
 * 237, escolha 3-B" em `fn_conversation_assign`), a conversa que a IA atende
 * fica com a IA (`detalhe.puladas_ia`). Conversa que já é da pessoa não é
 * tocada (`detalhe.ja_eram_dela`): nem zera não-lidas nem avisa de novo. Uma
 * conversa que falha não interrompe as próximas (`detalhe.falhas`), salvo a
 * pessoa recusada pelo banco, que vale para todas.
 *
 * ⚠️ Service role: organização vem da INSCRIÇÃO (`c.org`), nunca do grafo; a
 * pessoa é conferida no banco como membro ativo desta organização e toda
 * consulta filtra `organization_id`.
 */
import { audit } from "@/lib/audit";
import { idsDoContatoEGemeos } from "@/lib/channels/contato-por-telefone";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
import {
  sincronizarNegocioAbertoDoContato,
  type ResultadoDaSincronia,
} from "@/lib/inbox/negocio-aberto-do-contato";

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

/** Quantas conversas o modo `todas` alcança numa execução. */
const MAX_CONVERSAS = 20;

type Alvo = {
  id: string;
  contact_id: string | null;
  assigned_to_user_id: string | null;
  channel_session_id: string | null;
  status: string;
  is_group: boolean | null;
  bot_silenced_until: string | null;
};
type TravasDoContato = { force_human: boolean | null; is_blocked: boolean | null };
type Escolha = {
  /** A principal primeiro; com `todas`, as demais em seguida, a mais recente primeiro. */
  conversas: Alvo[];
  pessoal: boolean;
  truncado: boolean;
  /** `force_human`/`is_blocked` por contato (o da execução e os gêmeos). */
  travas: Map<string, TravasDoContato>;
};

/**
 * A IA está no comando desta conversa? Espelho, conversa a conversa, de
 * `public.comando_da_conversa(c) = 'automatico'` — a mesma régua que
 * `fn_conversation_assign` usa para não adotar a conversa da IA. A regra é
 * `comandoDaConversa` (o espelho TS de `fn_comando_da_conversa`, casado pelo
 * invariante `comando-da-conversa-espelha-o-ts`), com as travas do contato DA
 * CONVERSA, como a função SQL resolve. `automaticoDaOrg` fica ausente de
 * propósito: o SQL não o considera.
 */
function iaNoComando(alvo: Alvo, travas: Map<string, TravasDoContato>): boolean {
  const t = alvo.contact_id ? travas.get(alvo.contact_id) : undefined;
  return (
    comandoDaConversa({
      status: alvo.status,
      assigned_to_user_id: alvo.assigned_to_user_id,
      bot_silenced_until: alvo.bot_silenced_until,
      is_group: alvo.is_group ?? false,
      force_human: t?.force_human ?? false,
      is_blocked: t?.is_blocked ?? false,
    }).comando.quem === "automatico"
  );
}

/**
 * As conversas a atribuir. Padrão: UMA — a mais recente (não fechada) no canal
 * do gatilho; senão, a mais recente do contato. Com `todas`: essa primeiro e,
 * depois, as demais conversas não fechadas do contato e dos gêmeos (WhatsApp,
 * Messenger, Direct…), a mais recente primeiro — o "transferir todas as
 * conversas do lead" de quem migra.
 */
async function conversasAAtribuir(c: Contexto, todas: boolean): Promise<Escolha> {
  const vazia = (pessoal: boolean): Escolha => ({ conversas: [], pessoal, truncado: false, travas: new Map() });
  const ids = await idsDoContatoEGemeos(c.admin, c.org, c.contatoId);
  if (ids.length === 0) return vazia(false);
  // Pessoal some do atendimento (spec 21): o contato ou qualquer gêmeo basta.
  // A mesma leitura traz as travas que decidem se a IA está no comando.
  const { data: contatos, error: erroContatos } = await c.admin
    .from("contacts")
    .select("id, is_personal, force_human, is_blocked")
    .eq("organization_id", c.org)
    .in("id", [...ids]);
  if (erroContatos) throw new Error("conversa_indeterminada");
  const linhasDeContato = (contatos ?? []) as Array<{ id: string; is_personal: boolean | null } & TravasDoContato>;
  if (linhasDeContato.some((l) => l.is_personal === true)) return vazia(true);
  const travas = new Map(linhasDeContato.map((l) => [l.id, { force_human: l.force_human, is_blocked: l.is_blocked }]));

  const { data, error } = await c.admin
    .from("conversations")
    .select("id, contact_id, channel_session_id, assigned_to_user_id, status, is_group, bot_silenced_until, last_message_at")
    .eq("organization_id", c.org)
    .in("contact_id", [...ids])
    .eq("is_group", false)
    .not("status", "in", STATUS_FECHADOS)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    // Uma a mais que o teto: é ela que diz se ficou conversa de fora.
    .limit(MAX_CONVERSAS + 1);
  if (error) throw new Error("conversa_indeterminada");
  const todasAsLinhas = (data ?? []) as Alvo[];
  const linhas = todasAsLinhas.slice(0, MAX_CONVERSAS);
  const canal = canalDoGatilho(c.vars ?? c.fatos?.vars);
  const doCanal = canal ? linhas.find((l) => l.channel_session_id === canal) : undefined;
  const principal = doCanal ?? linhas[0];
  if (!principal) return { conversas: [], pessoal: false, truncado: false, travas };
  if (!todas) return { conversas: [principal], pessoal: false, truncado: false, travas };
  return {
    conversas: [principal, ...linhas.filter((l) => l.id !== principal.id)],
    pessoal: false,
    truncado: todasAsLinhas.length > MAX_CONVERSAS,
    travas,
  };
}

type ErroDaTroca = "usuario_invalido" | "efeito_falhou" | "sem_conversa";

export async function executarAtribuirConversa(
  c: Contexto,
  acao: Atribuir,
  /** Membro ativo (e não só visualizador) desta organização — a régua dos outros efeitos de pessoa. */
  membroAtivo: (c: Contexto, userId: string) => Promise<boolean>,
): Promise<Passo> {
  const base = { tipo: acao.type };
  if (!(await membroAtivo(c, acao.user_id))) return { ok: false, erro: "usuario_invalido", detalhe: base };

  const todas = acao.todas === true;
  const { conversas, pessoal, truncado, travas } = await conversasAAtribuir(c, todas);
  if (pessoal) return { ok: false, erro: "contato_pessoal", detalhe: base };
  if (conversas.length === 0) return { ok: false, erro: "sem_conversa", detalhe: base };
  // O negócio aberto segue o atendente uma vez por CONTATO (o lead e cada gêmeo).
  const sincronias = new Map<string, ResultadoDaSincronia>();

  if (!todas) {
    const r = await atribuirUma(c, acao, conversas[0]!, sincronias);
    if (!r.ok) return { ok: false, erro: r.erro, detalhe: base };
    return { ok: true, detalhe: { ...base, conversation_id: r.conversationId, user_id: acao.user_id } };
  }

  // A principal primeiro, depois as demais. O que já foi atribuído não se desfaz.
  const atribuidas: string[] = [];
  const falhas: ErroDaTroca[] = [];
  let jaEramDela = 0;
  let puladasIa = 0;
  for (const [i, alvo] of conversas.entries()) {
    if (alvo.assigned_to_user_id === acao.user_id) {
      jaEramDela += 1;
      continue;
    }
    if (i > 0 && iaNoComando(alvo, travas)) {
      puladasIa += 1;
      continue;
    }
    const r = await atribuirUma(c, acao, alvo, sincronias);
    if (r.ok) {
      atribuidas.push(r.conversationId);
      continue;
    }
    falhas.push(r.erro);
    // A pessoa recusada pelo banco vale para todas: não adianta tentar as próximas.
    if (r.erro === "usuario_invalido") break;
  }
  if (atribuidas.length === 0 && jaEramDela === 0) {
    return { ok: false, erro: falhas[0] ?? "sem_conversa", detalhe: base };
  }
  return {
    ok: true,
    detalhe: {
      ...base,
      conversation_id: atribuidas[0] ?? conversas[0]!.id,
      user_id: acao.user_id,
      conversas: atribuidas.length,
      ja_eram_dela: jaEramDela,
      puladas_ia: puladasIa,
      ...(falhas.length > 0 ? { falhas: falhas.length } : {}),
      ...(truncado ? { truncado: true } : {}),
    },
  };
}

async function atribuirUma(
  c: Contexto,
  acao: Atribuir,
  alvo: Alvo,
  /** A sincronia do negócio já feita nesta ação, por contato: cada contato vai ao negócio uma vez. */
  sincronias: Map<string, ResultadoDaSincronia>,
): Promise<{ ok: true; conversationId: string } | { ok: false; erro: ErroDaTroca }> {
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
    return { ok: false, erro: recusada ? "usuario_invalido" : "efeito_falhou" };
  }
  const conversa = (
    data as Array<{
      id: string;
      organization_id: string;
      contact_id: string | null;
      channel_session_id?: string | null;
    }> | null
  )?.[0];
  if (!conversa) return { ok: false, erro: "sem_conversa" };

  // O negócio aberto do contato segue o atendente, como na transferência manual
  // — uma vez por contato DISTINTO, mesmo com várias conversas dele. A segunda
  // conversa do mesmo contato audita o motivo real da sincronia já feita.
  // Tolerado: a troca de dono já aconteceu; o motivo vai para a auditoria.
  const contatoDaConversa = conversa.contact_id ?? c.contatoId;
  let sincronia = sincronias.get(contatoDaConversa);
  if (!sincronia) {
    sincronia = await sincronizarNegocioAbertoDoContato(c.admin, {
      organizationId: c.org,
      contactId: contatoDaConversa,
      toUserId: acao.user_id,
    });
    sincronias.set(contatoDaConversa, sincronia);
  }
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

  return { ok: true, conversationId: conversa.id };
}
