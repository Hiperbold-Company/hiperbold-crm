/**
 * O WORKER DAS MENSAGENS AGENDADAS (migration 1017) — chamado pelo cron
 * `app/api/v1/cron/mensagens-agendadas`, a cada minuto.
 *
 * ─── Uma vez só, nunca duas ─────────────────────────────────────────────────
 *
 * A reserva é do banco: `fn_reservar_mensagens_agendadas` troca `agendada` por
 * `enviando` com `for update skip locked` e devolve só o que ESTA rodada
 * reservou. Duas rodadas sobrepostas (o curl do scheduler corta, a rota não)
 * nunca pegam a mesma linha. Toda conclusão depois disso é `update ... where
 * status = 'enviando'`: quem não reservou não conclui.
 *
 * ─── A mesma porta do compositor ────────────────────────────────────────────
 *
 * O envio passa por `sendMessageHandler` com o ator `user` = quem agendou: é a
 * mensagem que ele escreveu, saindo como se ele apertasse Enviar agora. Então a
 * janela de 24h, o número da conversa, o contato pessoal, a organização parada,
 * o canal arquivado e o audit da mensagem são os de sempre. Este worker só
 * acrescenta o que é do agendamento:
 *
 *   - opt-out NA HORA: contato bloqueado cancela (o compositor ainda deixa uma
 *     resposta humana passar dentro da janela, D-116; uma mensagem marcada dias
 *     antes não é essa resposta);
 *   - quem agendou ainda atende nesta empresa (senão a mensagem sairia em nome
 *     de quem saiu da equipe), ainda tem `chat.responder` pelo resolvedor de
 *     permissões e ainda ENXERGA a conversa pela régua da inbox
 *     (`revalidarAutor`, `./autor.ts`) — o cliente de serviço não passa pela RLS;
 *   - o modelo, quando é ele que sai, ainda está APROVADO na conexão da
 *     conversa, com o texto da definição guardada (`modeloAprovadoDaConexao`);
 *   - janela de HORÁRIO do canal (7h–22h por padrão): fora dela a linha volta a
 *     `agendada` com `adiada_ate` na próxima abertura;
 *   - texto ou modelo pela janela de 24h (`decidirEnvioAgendado`);
 *   - espaçamento entre envios do mesmo número (`espacarEnvio`, anti-ban).
 *
 * ─── Falha tem aviso, e nada se reenvia sozinho ─────────────────────────────
 *
 * Toda falha grava o motivo na linha e abre UM aviso por organização por rodada
 * na Central (`agent_inbox_items`, kind `message_send_stuck`, o mesmo padrão do
 * `recover-stuck-messages`). Linha presa em `enviando` (o processo caiu no meio
 * do envio) vira `falhou` depois de `PRESA_APOS_MS`, sem reenvio: não dá para
 * saber se a mensagem saiu, e chegar duas vezes é pior que não chegar.
 *
 * ─── O lease: a presa é só a que ninguém está enviando ──────────────────────
 *
 * `reservada_em` é o lease. A rodada o RENOVA logo antes de cada envio
 * (`update ... where status = 'enviando'`); se a renovação não alcança a linha
 * (outra rodada já a deu como presa), nada sai. E a rodada não começa envio
 * novo depois de `PRAZO_DA_RODADA_MS`: o que sobrou volta para `agendada`. Com
 * as duas travas, uma linha em envio tem lease de no máximo UM envio, muito
 * abaixo de `PRESA_APOS_MS` — `recuperarPresas` de uma rodada sobreposta não a
 * alcança.
 *
 * ─── Reserva justa entre organizações ───────────────────────────────────────
 *
 * Uma organização reserva no máximo `RESERVAS_POR_ORG_POR_RODADA` das
 * `RESERVAS_POR_RODADA` de cada rodada: a reserva chama a função do banco em
 * voltas, cada uma com `p_limite` que nenhuma organização pode estourar, e a
 * organização que bate o teto entra na lista de exclusão das voltas seguintes.
 * O conserto definitivo é a própria função receber o teto por organização
 * (precisa de migration).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { roleAtLeast } from "@/lib/auth/types";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { espacarEnvio } from "@/lib/automation/throttle";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas, OrgNaoOperanteError } from "@/lib/organizacao/operante";
import type { Message } from "@/lib/types/messaging";

import { revalidarAutor } from "./autor";
import { decidirEnvioAgendado, lerModelo, PRAZO_DA_RODADA_MS, PRESA_APOS_MS } from "./regras";
import { modeloAprovadoDaConexao, type LinhaDaAgendada } from "./servidor";

/** Teto de reservas por rodada: com o espaçamento anti-ban (~2 s por envio do mesmo número), 20 cabem no corte de 50 s do scheduler. */
export const RESERVAS_POR_RODADA = 20;

/** Teto por organização em cada rodada: uma organização com fila grande não ocupa as 20 reservas. */
export const RESERVAS_POR_ORG_POR_RODADA = 5;

export const MOTIVO_OPT_OUT = "O contato pediu para não receber mensagens. A mensagem agendada foi cancelada.";
export const MOTIVO_ANONIMIZADO = "O contato foi anonimizado. A mensagem agendada foi cancelada.";
export const MOTIVO_SEM_AUTOR = "Quem agendou não atende mais nesta empresa. A mensagem agendada foi cancelada.";
export const MOTIVO_SEM_PERMISSAO =
  "Quem agendou não tem mais permissão para responder no chat. A mensagem agendada foi cancelada.";
export const MOTIVO_SEM_VISIBILIDADE = "Quem agendou não enxerga mais esta conversa. A mensagem agendada foi cancelada.";
export const MOTIVO_MODELO_NAO_APROVADO =
  "O modelo escolhido não está mais aprovado na conexão desta conversa. Nada foi enviado.";
export const MOTIVO_SEM_CONVERSA = "A conversa não existe mais. Nada foi enviado.";
export const MOTIVO_CANAL_RECUSOU = "O canal recusou o envio. O motivo está na mensagem, na conversa.";
export const MOTIVO_ERRO = "Não foi possível enviar no horário. Nada foi reenviado automaticamente.";
export const MOTIVO_PRESA =
  "O envio foi interrompido no meio e não foi repetido, para a mensagem não chegar duas vezes. Confira a conversa.";

type Enviar = typeof sendMessageHandler;

export interface DepsDoWorker {
  enviar: Enviar;
  espacar: (channelSessionId: string) => Promise<void>;
  adiar: (admin: SupabaseClient, org: string, channelSessionId: string, agora: Date) => Promise<string | null>;
  /** O relógio de agora, para o lease e o prazo da rodada (o `agora` da rodada envelhece). */
  relogio?: () => Date;
}

const DEPS_REAIS: DepsDoWorker = {
  enviar: sendMessageHandler,
  espacar: espacarEnvio,
  adiar: adiarAteAJanelaAbrir,
  relogio: () => new Date(),
};

export interface ResultadoDaRodada {
  reservadas: number;
  enviadas: number;
  canceladas: number;
  falhas: number;
  adiadas: number;
  presas: number;
  organizacoes_avisadas: number;
}

type Desfecho =
  | { status: "enviada"; messageId: string }
  | { status: "cancelada"; motivo: string }
  | { status: "falhou"; motivo: string; messageId?: string | null }
  | { status: "agendada"; adiadaAte: string | null }
  /** O lease não pôde ser renovado: outra rodada já concluiu a linha. Nada sai e nada se grava. */
  | { status: "perdida" };

/** Conclui só a linha que ESTA rodada reservou (`status = 'enviando'`). */
async function concluir(
  admin: SupabaseClient,
  linha: LinhaDaAgendada,
  desfecho: Desfecho,
  agora: Date,
): Promise<boolean> {
  if (desfecho.status === "perdida") return false;
  const agoraIso = agora.toISOString();
  const patch: Record<string, unknown> =
    desfecho.status === "agendada"
      ? { status: "agendada", adiada_ate: desfecho.adiadaAte, reservada_em: null, updated_at: agoraIso }
      : {
          status: desfecho.status,
          motivo: desfecho.status === "enviada" ? null : desfecho.motivo,
          message_id:
            desfecho.status === "enviada" ? desfecho.messageId : desfecho.status === "falhou" ? (desfecho.messageId ?? null) : null,
          concluida_em: agoraIso,
          updated_at: agoraIso,
        };
  const { data, error } = await admin
    .from("scheduled_messages")
    .update(patch)
    .eq("id", linha.id)
    .eq("organization_id", linha.organization_id)
    .eq("status", "enviando")
    .select("id");
  if (error) {
    logger.error("[mensagens-agendadas] conclusão falhou", {
      error: error.message,
      scheduled_message_id: linha.id,
      organization_id: linha.organization_id,
    });
    return false;
  }
  return ((data ?? []) as unknown[]).length > 0;
}

/** O envio de UMA linha já reservada. Nunca lança: todo caminho vira desfecho. */
async function processar(
  admin: SupabaseClient,
  linha: LinhaDaAgendada,
  agora: Date,
  requestId: string,
  deps: DepsDoWorker,
): Promise<Desfecho> {
  const org = linha.organization_id;

  const { data: conversaLida, error: erroConversa } = await admin
    .from("conversations")
    .select("id, contact_id, channel_session_id, last_inbound_at, assigned_to_user_id")
    .eq("id", linha.conversation_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (erroConversa) throw new Error(`conversa: ${erroConversa.message}`);
  const conversa = conversaLida as {
    id: string;
    contact_id: string | null;
    channel_session_id: string | null;
    last_inbound_at: string | null;
    assigned_to_user_id?: string | null;
  } | null;
  if (!conversa) return { status: "falhou", motivo: MOTIVO_SEM_CONVERSA };

  let contatoPessoal = false;
  if (conversa.contact_id) {
    const { data: contato, error } = await admin
      .from("contacts")
      .select("id, is_blocked, is_anonymized, is_personal")
      .eq("id", conversa.contact_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (error) throw new Error(`contato: ${error.message}`);
    const c = contato as { is_blocked?: boolean | null; is_anonymized?: boolean | null; is_personal?: boolean | null } | null;
    if (c?.is_blocked) return { status: "cancelada", motivo: MOTIVO_OPT_OUT };
    if (c?.is_anonymized) return { status: "cancelada", motivo: MOTIVO_ANONIMIZADO };
    contatoPessoal = c?.is_personal === true;
  }

  if (!linha.created_by) return { status: "cancelada", motivo: MOTIVO_SEM_AUTOR };
  const { data: membro, error: erroMembro } = await admin
    .from("user_organizations")
    .select("user_id, role, revoked_at")
    .eq("organization_id", org)
    .eq("user_id", linha.created_by)
    .is("revoked_at", null)
    .maybeSingle();
  if (erroMembro) throw new Error(`membro: ${erroMembro.message}`);
  const papel = (membro as { role?: string } | null)?.role ?? null;
  if (!papel || !roleAtLeast(papel, "agent")) return { status: "cancelada", motivo: MOTIVO_SEM_AUTOR };

  // Permissão e visibilidade de AGORA, com as réguas da rota e da inbox.
  const autor = await revalidarAutor(admin, {
    organizationId: org,
    autorId: linha.created_by,
    papel,
    conversationId: conversa.id,
    atribuidaA: conversa.assigned_to_user_id ?? null,
    contatoPessoal,
  });
  if (!autor.ok) {
    return { status: "cancelada", motivo: autor.motivo === "sem_permissao" ? MOTIVO_SEM_PERMISSAO : MOTIVO_SEM_VISIBILIDADE };
  }

  let provider: string | null = null;
  if (conversa.channel_session_id) {
    const { data: canal, error } = await admin
      .from("channel_sessions")
      .select("id, provider")
      .eq("id", conversa.channel_session_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (error) throw new Error(`canal: ${error.message}`);
    provider = (canal as { provider?: string | null } | null)?.provider ?? null;

    // A janela de HORÁRIO do canal: fora dela, a linha espera a próxima abertura.
    const proximaAbertura = await deps.adiar(admin, org, conversa.channel_session_id, agora);
    if (proximaAbertura) return { status: "agendada", adiadaAte: proximaAbertura };
  }

  const modelo = lerModelo(linha.template);
  const decisao = decidirEnvioAgendado({
    provider,
    lastInboundAt: conversa.last_inbound_at,
    agora,
    temModelo: modelo !== null,
  });
  if (decisao.tipo === "falha") return { status: "falhou", motivo: decisao.motivo };

  // O modelo que sai é o APROVADO agora na conexão da conversa, com o texto da
  // definição guardada: entre agendar e enviar ele pode ter sido pausado ou apagado.
  let modeloDoEnvio = modelo;
  if (decisao.tipo === "modelo" && modelo) {
    const conferido = await modeloAprovadoDaConexao(admin, org, conversa.channel_session_id, modelo);
    if (!conferido.ok) {
      throw new Error(`modelo: ${(conferido.erro as { message?: string } | null)?.message ?? String(conferido.erro)}`);
    }
    if (!conferido.valor) return { status: "falhou", motivo: MOTIVO_MODELO_NAO_APROVADO };
    modeloDoEnvio = conferido.valor;
  }

  const entrada: Parameters<Enviar>[2] =
    decisao.tipo === "modelo" && modeloDoEnvio
      ? ({
          conversation_id: conversa.id,
          type: "template",
          template_name: modeloDoEnvio.name,
          template_language: modeloDoEnvio.language,
          template_values: modeloDoEnvio.values,
          body: modeloDoEnvio.body,
        } as Parameters<Enviar>[2])
      : ({ conversation_id: conversa.id, type: "text", body: linha.body } as Parameters<Enviar>[2]);

  if (conversa.channel_session_id) await deps.espacar(conversa.channel_session_id);

  // Renova o lease logo antes de enviar. Se outra rodada já deu a linha como
  // presa (ou a concluiu), a renovação não a alcança e nada sai.
  const relogio = deps.relogio ?? (() => new Date());
  const { data: renovada, error: erroLease } = await admin
    .from("scheduled_messages")
    .update({ reservada_em: relogio().toISOString() })
    .eq("id", linha.id)
    .eq("organization_id", org)
    .eq("status", "enviando")
    .select("id");
  if (erroLease) throw new Error(`lease: ${erroLease.message}`);
  if (((renovada ?? []) as unknown[]).length === 0) return { status: "perdida" };

  let mensagem: Message;
  try {
    mensagem = await deps.enviar(
      admin,
      {
        organization_id: org,
        actor: { type: "user", id: linha.created_by, role: papel },
        requestId: `mensagens-agendadas:${linha.id}`,
      },
      entrada,
    );
  } catch (err) {
    // A organização parou entre a reserva e o envio: a mensagem espera a volta
    // dela, como espera a janela do canal. Não é falha de ninguém.
    if (err instanceof OrgNaoOperanteError) return { status: "agendada", adiadaAte: null };
    if (err instanceof ApiError && err.status < 500 && err.message && err.message !== err.code) {
      // A porta de envio recusou com frase para pessoa (janela, número de outro
      // atendente, contato pessoal, canal arquivado): é ela que vai na linha.
      // Erro 5xx e código cru não são frase: caem no motivo genérico abaixo.
      return { status: "falhou", motivo: err.message };
    }
    logger.error("[mensagens-agendadas] envio falhou", {
      error: err instanceof Error ? err.message : String(err),
      scheduled_message_id: linha.id,
      organization_id: org,
      requestId,
    });
    return { status: "falhou", motivo: MOTIVO_ERRO };
  }

  if (mensagem.status === "failed") return { status: "falhou", motivo: MOTIVO_CANAL_RECUSOU, messageId: mensagem.id };
  return { status: "enviada", messageId: mensagem.id };
}

interface Falha {
  organizationId: string;
  conversationId: string;
}

/** Linhas `enviando` velhas demais: o processo caiu no meio. Viram falha, sem reenvio. */
async function recuperarPresas(admin: SupabaseClient, agora: Date): Promise<Falha[]> {
  const corte = new Date(agora.getTime() - PRESA_APOS_MS).toISOString();
  const { data, error } = await admin
    .from("scheduled_messages")
    .select("id, organization_id, conversation_id")
    .eq("status", "enviando")
    .lt("reservada_em", corte)
    .order("reservada_em", { ascending: true })
    .limit(200);
  if (error) throw new Error(`presas: ${error.message}`);
  const presas = (data ?? []) as Array<{ id: string; organization_id: string; conversation_id: string }>;

  const porOrg = new Map<string, typeof presas>();
  for (const p of presas) porOrg.set(p.organization_id, [...(porOrg.get(p.organization_id) ?? []), p]);

  const falhas: Falha[] = [];
  const agoraIso = agora.toISOString();
  for (const [org, linhas] of porOrg) {
    const { data: marcadas, error: erro } = await admin
      .from("scheduled_messages")
      .update({ status: "falhou", motivo: MOTIVO_PRESA, concluida_em: agoraIso, updated_at: agoraIso })
      .in(
        "id",
        linhas.map((l) => l.id),
      )
      .eq("organization_id", org)
      .eq("status", "enviando")
      .select("id, conversation_id");
    if (erro) {
      logger.error("[mensagens-agendadas] recuperar presas falhou", { error: erro.message, organization_id: org });
      continue;
    }
    for (const m of (marcadas ?? []) as Array<{ conversation_id: string }>) {
      falhas.push({ organizationId: org, conversationId: m.conversation_id });
    }
  }
  return falhas;
}

/**
 * A reserva da rodada, justa entre organizações (ver o cabeçalho). Cada volta
 * pede à função do banco no máximo o que NENHUMA organização ainda elegível pode
 * receber sem passar do teto; quem bate o teto vai para a exclusão. Toda volta
 * que devolve algo reserva ao menos uma linha, então são no máximo
 * `RESERVAS_POR_RODADA` voltas. Nada é reservado a mais para devolver depois:
 * devolver mudaria `updated_at` e a tela de quem edita levaria 409.
 */
async function reservarComJustica(admin: SupabaseClient, paradas: string[]): Promise<LinhaDaAgendada[]> {
  const reservadas: LinhaDaAgendada[] = [];
  const porOrg = new Map<string, number>();
  const excluidas = new Set(paradas);
  for (let volta = 0; volta < RESERVAS_POR_RODADA && reservadas.length < RESERVAS_POR_RODADA; volta++) {
    let maior = 0;
    for (const [org, n] of porOrg) if (!excluidas.has(org) && n > maior) maior = n;
    const limite = Math.min(RESERVAS_POR_RODADA - reservadas.length, RESERVAS_POR_ORG_POR_RODADA - maior);
    if (limite <= 0) break;
    const { data, error } = await admin.rpc("fn_reservar_mensagens_agendadas", {
      p_limite: limite,
      p_orgs_paradas: [...excluidas],
    });
    if (error) throw new Error(`reserva: ${error.message}`);
    const lote = (data ?? []) as LinhaDaAgendada[];
    if (lote.length === 0) break;
    for (const linha of lote) {
      reservadas.push(linha);
      const n = (porOrg.get(linha.organization_id) ?? 0) + 1;
      porOrg.set(linha.organization_id, n);
      if (n >= RESERVAS_POR_ORG_POR_RODADA) excluidas.add(linha.organization_id);
    }
  }
  return reservadas;
}

/** Um aviso por organização por rodada — N avisos iguais enterrariam a Central. */
async function avisar(admin: SupabaseClient, falhas: Falha[], requestId: string): Promise<number> {
  const porOrg = new Map<string, Falha[]>();
  for (const f of falhas) porOrg.set(f.organizationId, [...(porOrg.get(f.organizationId) ?? []), f]);
  let avisadas = 0;
  for (const [org, itens] of porOrg) {
    const n = itens.length;
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: org,
      kind: "message_send_stuck",
      severity: "warn",
      title: n === 1 ? "Uma mensagem agendada não foi enviada" : `${n} mensagens agendadas não foram enviadas`,
      body:
        "O motivo está no balão da mensagem, no fim da conversa. " +
        "Nada foi reenviado automaticamente: abra a conversa e decida se agenda de novo.",
      ref_kind: "conversation",
      ref_id: itens[0]?.conversationId ?? null,
    });
    if (error) {
      logger.error("[mensagens-agendadas] aviso na Central falhou", { error: error.message, organization_id: org, requestId });
      continue;
    }
    avisadas += 1;
  }
  return avisadas;
}

export async function rodarMensagensAgendadas(
  admin: SupabaseClient,
  agora: Date,
  requestId: string,
  deps: DepsDoWorker = DEPS_REAIS,
): Promise<ResultadoDaRodada> {
  const resultado: ResultadoDaRodada = {
    reservadas: 0,
    enviadas: 0,
    canceladas: 0,
    falhas: 0,
    adiadas: 0,
    presas: 0,
    organizacoes_avisadas: 0,
  };

  const falhas = await recuperarPresas(admin, agora);
  resultado.presas = falhas.length;

  // Organização parada não envia: a linha dela nem é reservada, e sai quando ela voltar.
  const paradas = await idsDeOrgsParadas(admin);
  const reservadas = await reservarComJustica(admin, paradas);
  resultado.reservadas = reservadas.length;

  const relogio = deps.relogio ?? (() => new Date());
  const inicio = relogio().getTime();
  for (const linha of reservadas) {
    let desfecho: Desfecho;
    // Passado o prazo da rodada, nada de envio novo: o que sobrou volta para a fila.
    if (relogio().getTime() - inicio > PRAZO_DA_RODADA_MS) {
      if (await concluir(admin, linha, { status: "agendada", adiadaAte: null }, agora)) resultado.adiadas += 1;
      continue;
    }
    try {
      desfecho = await processar(admin, linha, agora, requestId, deps);
    } catch (err) {
      logger.error("[mensagens-agendadas] leitura falhou", {
        error: err instanceof Error ? err.message : String(err),
        scheduled_message_id: linha.id,
        organization_id: linha.organization_id,
        requestId,
      });
      // Nada saiu: a linha volta para a fila e a próxima rodada tenta de novo.
      desfecho = { status: "agendada", adiadaAte: null };
    }
    const gravou = await concluir(admin, linha, desfecho, agora);
    if (!gravou) continue;
    if (desfecho.status === "enviada") resultado.enviadas += 1;
    else if (desfecho.status === "cancelada") resultado.canceladas += 1;
    else if (desfecho.status === "agendada") resultado.adiadas += 1;
    else {
      resultado.falhas += 1;
      falhas.push({ organizationId: linha.organization_id, conversationId: linha.conversation_id });
    }
  }

  resultado.organizacoes_avisadas = falhas.length > 0 ? await avisar(admin, falhas, requestId) : 0;
  return resultado;
}

/** Houve efeito: só então a rodada audita (CLAUDE.md, cron que não fez nada não audita). */
export function houveEfeito(r: ResultadoDaRodada): boolean {
  return r.enviadas + r.canceladas + r.falhas + r.presas > 0;
}
