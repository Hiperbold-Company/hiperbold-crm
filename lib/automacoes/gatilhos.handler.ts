/**
 * Handler do `event_log` que INICIA automações (`automacao-gatilhos.v1`).
 *
 * Para cada evento que um gatilho conhece (negócio criado ou mudou de etapa,
 * tag adicionada, mensagem recebida, agendamento, aniversário, caso aberto): lê as automações ATIVAS da
 * organização (índice `(organization_id, surface, status)`, 0986), confere os
 * gatilhos do grafo publicado (cache por `version_id` — versão é imutável) e
 * chama `fn_automacao_iniciar` com `origin_event_id` = a linha do evento: um
 * re-drain do mesmo evento não abre segunda execução.
 *
 * Anti-laço: o evento causado por uma automação não dispara a MESMA automação
 * (`request_id = automacao:<pointer>:…`), e o causado por uma REGRA antiga
 * (`caused_by_rule`, `request_id = rule:…`) não dispara nenhuma. Organização em modo leitura não
 * inicia nada (mesma regra dos gatilhos de follow-up). Trigger Postgres nunca
 * faz HTTP: tudo aqui roda no worker.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { contaBloqueadaParaProduzir } from "@/lib/billing/assinatura/pode-produzir";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { humanoNoComando } from "@/lib/followup/gatilho-retorno";
import { createAdminClient } from "@/lib/supabase/admin";

import { AUTOMACAO_GATILHOS_HANDLER_KEY } from "./chaves";
import {
  EVENTOS_DE_AGENDAMENTO_NO_LOG,
  casaGatilho,
  execucaoQueCausou,
  fatosDoEvento,
  gatilhosDoGrafo,
  varsDoGatilho,
  type FatoDeComentario,
  type FatoDeGatilho,
  type FatoDeMensagem,
} from "./gatilhos";
import { EVENTO_COMENTARIO_RECEBIDO, identidadeDoComentarista, type IdentidadeDoComentarista } from "./canal-de-comentarios";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { logger } from "@/lib/logger";
import { iniciarAutomacao, type InicioDaAutomacao } from "./iniciar";
import type { AutomacaoTrigger, AutomacaoTriggerConfig } from "./schemas";
import { IDADE_MAXIMA_DA_MENSAGEM_MS, automacaoEsperaRespostaNaConversaSupabase } from "./uma-voz";

export { AUTOMACAO_GATILHOS_HANDLER_KEY } from "./chaves";
export const EVENTOS_DOS_GATILHOS = [
  "lead.created",
  "lead.stage_changed",
  "lead.tag_added",
  "contact.tag_added",
  "contact.birthday",
  "message.received",
  "ai.case_opened",
  EVENTO_COMENTARIO_RECEBIDO,
  ...Object.keys(EVENTOS_DE_AGENDAMENTO_NO_LOG),
] as const;

export interface GatilhosDb {
  automacoesAtivas(orgId: string): Promise<Array<{ id: string; active_version_id: string }>>;
  gatilhosDaVersao(orgId: string, versionId: string): Promise<AutomacaoTriggerConfig | null>;
  contatoDoNegocio(orgId: string, leadId: string): Promise<string | null>;
  /** O contato do compromisso, lido da LINHA (`calendar_appointments`), não do payload. */
  contatoDoAgendamento(orgId: string, appointmentId: string): Promise<string | null>;
  contatoDaConversa(orgId: string, conversationId: string): Promise<string | null>;
  /** `true` grupo, `false` conversa individual, `null` conversa não encontrada na organização. */
  conversaDeGrupo(orgId: string, conversationId: string): Promise<boolean | null>;
  /** A linha da mensagem (organização e conversa conferidas): quando CHEGOU. `null` = não é desta conversa. */
  mensagemDaConversa(orgId: string, conversationId: string, messageId: string): Promise<{ created_at: string } | null>;
  /**
   * A mensagem é resposta a uma automação NESTA conversa — esperando agora, ou
   * esperando quando a mensagem chegou (`uma-voz.ts`)?
   */
  respostaAAutomacaoNaConversa(orgId: string, conversationId: string, chegadaEm: string): Promise<boolean>;
  /** Nenhuma mensagem do contato nesta conversa ANTES desta (as mais novas não contam)? */
  primeiraMensagemDaConversa(
    orgId: string,
    conversationId: string,
    messageId: string,
    chegadaEm: string,
  ): Promise<boolean>;
  /** Há humano no comando da conversa (atendente, `force_human`, IA silenciada)? Mesmo critério do gate da IA. */
  humanoNaConversa(orgId: string, conversationId: string, agora: Date): Promise<boolean>;
  fonteDeCaptacaoDaOrg(orgId: string, fonteId: string): Promise<boolean>;
  /** Comentário: a identidade social do autor pela sessão de canal da organização (`null` = sessão alheia ou não é Instagram). */
  identidadeDoComentarista(
    orgId: string,
    channelSessionId: string,
    autorId: string,
  ): Promise<IdentidadeDoComentarista | null>;
  /** O contato VIVO da organização com esta identidade social (o mesmo que o Direct usa). */
  contatoPelaIdentidade(orgId: string, identidade: string): Promise<string | null>;
  /**
   * Cria o contato do comentarista pelo handler canônico (auditado) e grava a
   * identidade social nele, para o Direct depois cair no MESMO contato.
   */
  criarContatoDoComentarista(
    orgId: string,
    input: { identidade: string; usuario: string | null; pointerId: string; requestId: string },
  ): Promise<string | null>;
  iniciar(input: Parameters<typeof iniciarAutomacao>[1]): Promise<InicioDaAutomacao>;
  modoLeitura(orgId: string): Promise<boolean>;
}

export interface ResumoDosGatilhos {
  avaliadas: number;
  iniciadas: number;
  ignoradas: number;
}

const CACHE_MAX = 500;
const cacheDeGatilhos = new Map<string, AutomacaoTriggerConfig | null>();

/** O contato da execução, de fonte confiável: a linha da entidade, sempre filtrada pela organização. */
async function contatoDoFato(db: GatilhosDb, orgId: string, fato: FatoDeGatilho): Promise<string | null> {
  switch (fato.tipo) {
    case "lead_created":
    case "stage_entered_created":
    case "stage_entered_moved":
      return db.contatoDoNegocio(orgId, fato.lead_id);
    case "tag_added":
      return fato.alvo === "lead" && fato.lead_id ? db.contatoDoNegocio(orgId, fato.lead_id) : fato.contact_id;
    case "appointment":
      return db.contatoDoAgendamento(orgId, fato.appointment_id);
    case "case_opened":
      if (fato.conversation_id) return db.contatoDaConversa(orgId, fato.conversation_id);
      return fato.contact_id;
    // `entity_id` do contato e o `contact_id` que o gatilho do banco põe na
    // mensagem; o `fn_automacao_iniciar` recusa contato de outra organização.
    case "birthday":
    case "message_received":
      return fato.contact_id;
    // Resolvido à parte (pela identidade social, com criação opcional).
    case "instagram_comment":
      return null;
  }
}

/**
 * Mensagem com mais de `IDADE_MAXIMA_DA_MENSAGEM_MS` (desde que CHEGOU) não
 * inicia automação: um dreno parado que acorda com o backlog não pode
 * responder conversa de horas atrás — o espírito do anti-backlog do drain da IA.
 */
export { IDADE_MAXIMA_DA_MENSAGEM_MS };

/**
 * Mensagem recebida: as recusas que dependem do banco. Grupo nunca dispara;
 * mensagem velha (backlog) também não; a resposta a uma automação desta
 * conversa é DELA, e não inicia outras. Devolve `false` para descartar o evento.
 */
async function mensagemPodeDisparar(
  db: GatilhosDb,
  orgId: string,
  fato: FatoDeMensagem,
  configs: AutomacaoTriggerConfig[],
  agora: Date,
): Promise<boolean> {
  const gatilhos = configs
    .flatMap((c) => c.triggers)
    .filter((g): g is Extract<AutomacaoTrigger, { kind: "message_received" }> => g.kind === "message_received");
  if (gatilhos.length === 0) return false;
  if ((await db.conversaDeGrupo(orgId, fato.conversation_id)) !== false) return false;
  const linha = await db.mensagemDaConversa(orgId, fato.conversation_id, fato.message_id);
  if (!linha) return false;
  const chegou = Date.parse(linha.created_at);
  if (!Number.isFinite(chegou) || agora.getTime() - chegou > IDADE_MAXIMA_DA_MENSAGEM_MS) return false;
  if (await db.respostaAAutomacaoNaConversa(orgId, fato.conversation_id, linha.created_at)) return false;
  if (gatilhos.some((g) => g.only_first_message)) {
    fato.primeira_da_conversa = await db.primeiraMensagemDaConversa(
      orgId,
      fato.conversation_id,
      fato.message_id,
      linha.created_at,
    );
  }
  if (gatilhos.some((g) => g.skip_if_human !== false)) {
    fato.humano_no_comando = await db.humanoNaConversa(orgId, fato.conversation_id, agora);
  }
  return true;
}

export async function aplicarGatilhosDeAutomacao(
  db: GatilhosDb,
  row: EventRow,
  agora: Date = new Date(),
): Promise<ResumoDosGatilhos> {
  const resumo: ResumoDosGatilhos = { avaliadas: 0, iniciadas: 0, ignoradas: 0 };
  const fatos = fatosDoEvento(row);
  if (fatos.length === 0) return resumo;

  const automacoes = await db.automacoesAtivas(row.organization_id);
  if (automacoes.length === 0) return resumo;
  if (await db.modoLeitura(row.organization_id)) return resumo;

  const armadas: Array<{ id: string; cfg: AutomacaoTriggerConfig }> = [];
  for (const a of automacoes) {
    resumo.avaliadas++;
    const cfg = await db.gatilhosDaVersao(row.organization_id, a.active_version_id);
    if (cfg) armadas.push({ id: a.id, cfg });
  }
  if (armadas.length === 0) return resumo;

  const mensagem = fatos.find((f): f is FatoDeMensagem => f.tipo === "message_received");
  if (mensagem && !(await mensagemPodeDisparar(db, row.organization_id, mensagem, armadas.map((a) => a.cfg), agora))) {
    return resumo;
  }

  const comentario = fatos.find((f): f is FatoDeComentario => f.tipo === "instagram_comment");
  let identidade: IdentidadeDoComentarista | null = null;
  if (comentario) {
    const algum = armadas.some((a) => a.cfg.triggers.some((g) => g.kind === "instagram_comment"));
    if (!algum) return resumo;
    identidade = await db.identidadeDoComentarista(
      row.organization_id,
      comentario.channel_session_id,
      comentario.autor_id,
    );
    // Sessão de outra organização (ou que não é Instagram) e comentário da
    // PRÓPRIA conta (a resposta pública da automação volta como comentário) não disparam.
    if (!identidade || identidade.propriaConta) return resumo;
  }

  let contato: string | null | undefined;
  let fonteConfirmada: boolean | undefined;
  for (const a of armadas) {
    const { cfg } = a;
    // Fonte de captação: conferida no banco uma vez, e só quando um gatilho depende dela.
    const dependeDeFonte = cfg.triggers.some(
      (g) => g.kind === "lead_created" && (g.only_capture === true || (g.capture_source_ids?.length ?? 0) > 0),
    );
    const fonteDoEvento = fatos.find((f) => "fonte_id" in f && f.fonte_id !== null);
    if (dependeDeFonte && fonteConfirmada === undefined) {
      const fonteId = fonteDoEvento && "fonte_id" in fonteDoEvento ? fonteDoEvento.fonte_id : null;
      fonteConfirmada = fonteId ? await db.fonteDeCaptacaoDaOrg(row.organization_id, fonteId) : false;
    }
    const fato = fatos.find(
      (f) => f.causado_pela_automacao !== a.id && cfg.triggers.some((g) => casaGatilho(g, f, fonteConfirmada === true)),
    );
    if (!fato) continue;
    if (fato.tipo === "instagram_comment" && identidade) {
      // Contato do comentarista: o que o Direct já criou, ou um novo quando um
      // gatilho que casou pede (`create_contact`, ausente = sim). Sem contato e
      // sem pedido de criar, ESTA automação não inicia — outra pode criar.
      if (!contato) contato = await db.contatoPelaIdentidade(row.organization_id, identidade.identidade);
      const criar = cfg.triggers.some(
        (g) => g.kind === "instagram_comment" && g.create_contact !== false && casaGatilho(g, fato, false),
      );
      if (!contato && criar) {
        contato = await db.criarContatoDoComentarista(row.organization_id, {
          identidade: identidade.identidade,
          usuario: fato.autor_usuario,
          pointerId: a.id,
          requestId: `automacao:${a.id}:gatilho:${row.id}`,
        });
      }
      if (!contato) {
        logger.info("automacao: comentário sem contato no CRM e sem criar contato; não iniciada", {
          organization_id: row.organization_id,
          pointer_id: a.id,
          event_id: row.id,
        });
        resumo.ignoradas++;
        continue;
      }
    } else if (contato === undefined) contato = await contatoDoFato(db, row.organization_id, fato);
    if (!contato) {
      resumo.ignoradas++;
      continue;
    }
    const r = await db.iniciar({
      organizationId: row.organization_id,
      pointerId: a.id,
      contactId: contato,
      vars: varsDoGatilho(fato, row.id),
      originEventId: row.id,
      parentEnrollmentId: execucaoQueCausou(row),
    });
    if (r.resultado === "iniciada" || r.resultado === "reiniciada") resumo.iniciadas++;
    else resumo.ignoradas++;
  }
  return resumo;
}

export function createSupabaseGatilhosDb(admin: SupabaseClient): GatilhosDb {
  return {
    async automacoesAtivas(orgId) {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, active_version_id")
        .eq("organization_id", orgId)
        .eq("surface", "automacao")
        .eq("status", "active")
        .not("active_version_id", "is", null);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{ id: string; active_version_id: string | null }>).flatMap((p) =>
        p.active_version_id ? [{ id: p.id, active_version_id: p.active_version_id }] : [],
      );
    },
    async gatilhosDaVersao(orgId, versionId) {
      const chave = `${orgId}:${versionId}`;
      if (cacheDeGatilhos.has(chave)) return cacheDeGatilhos.get(chave) ?? null;
      const { data, error } = await admin
        .from("followup_flow_versions")
        .select("graph")
        .eq("organization_id", orgId)
        .eq("id", versionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const cfg = data ? gatilhosDoGrafo((data as { graph: unknown }).graph) : null;
      if (cacheDeGatilhos.size >= CACHE_MAX) cacheDeGatilhos.delete(cacheDeGatilhos.keys().next().value as string);
      cacheDeGatilhos.set(chave, cfg);
      return cfg;
    },
    async contatoDoNegocio(orgId, leadId) {
      const { data, error } = await admin
        .from("crm_leads")
        .select("contact_id")
        .eq("organization_id", orgId)
        .eq("id", leadId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { contact_id: string | null } | null)?.contact_id ?? null;
    },
    async contatoDoAgendamento(orgId, appointmentId) {
      const { data, error } = await admin
        .from("calendar_appointments")
        .select("contact_id")
        .eq("organization_id", orgId)
        .eq("id", appointmentId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { contact_id: string | null } | null)?.contact_id ?? null;
    },
    async contatoDaConversa(orgId, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select("contact_id")
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { contact_id: string | null } | null)?.contact_id ?? null;
    },
    async conversaDeGrupo(orgId, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select("is_group")
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? (data as { is_group: boolean }).is_group === true : null;
    },
    async mensagemDaConversa(orgId, conversationId, messageId) {
      const { data, error } = await admin
        .from("messages")
        .select("created_at")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("id", messageId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const c = (data as { created_at?: string } | null)?.created_at;
      return c ? { created_at: c } : null;
    },
    respostaAAutomacaoNaConversa: (orgId, conversationId, chegadaEm) =>
      automacaoEsperaRespostaNaConversaSupabase(admin, { organizationId: orgId, conversationId, chegadaEm }),
    async primeiraMensagemDaConversa(orgId, conversationId, messageId, chegadaEm) {
      // Só as ANTERIORES: a mensagem que chegou logo depois (o contato mandou
      // "oi" e "tudo bem?" em sequência) não tira da primeira o posto dela.
      const { data, error } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("direction", "inbound")
        .neq("id", messageId)
        .lt("created_at", chegadaEm)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length === 0;
    },
    async humanoNaConversa(orgId, conversationId, agora) {
      const { data, error } = await admin
        .from("conversations")
        .select("assignee_kind, bot_silenced_until, contacts:contact_id(force_human)")
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return false;
      const c = data as unknown as {
        assignee_kind: string | null;
        bot_silenced_until: string | null;
        contacts: { force_human: boolean | null } | null;
      };
      return humanoNoComando(
        {
          is_group: false,
          is_blocked: false,
          tags: [],
          force_human: c.contacts?.force_human === true,
          assignee_kind: c.assignee_kind,
          bot_silenced_until: c.bot_silenced_until,
        },
        agora,
      );
    },
    async fonteDeCaptacaoDaOrg(orgId, fonteId) {
      const { data, error } = await admin
        .from("webhook_sources")
        .select("id")
        .eq("organization_id", orgId)
        .eq("id", fonteId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data);
    },
    identidadeDoComentarista: (orgId, channelSessionId, autorId) =>
      identidadeDoComentarista(admin, { organizationId: orgId, channelSessionId, autorId }),
    async contatoPelaIdentidade(orgId, identidade) {
      const { data, error } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", orgId)
        .eq("social_identity", identidade)
        .is("is_merged_into", null)
        .maybeSingle();
      if (error) throw new Error("contato_do_comentario_indeterminado");
      return (data as { id: string } | null)?.id ?? null;
    },
    async criarContatoDoComentarista(orgId, { identidade, usuario, pointerId, requestId }) {
      const nome = usuario ? `@${usuario}` : undefined;
      // Ator: a automação que pediu (o mesmo desenho dos efeitos); a organização
      // é a da LINHA do evento, nunca do payload.
      const { contact } = await createContactHandler(
        admin,
        { organization_id: orgId, actor: { type: "webhook_source", id: pointerId }, requestId },
        {
          ...(nome ? { name: nome, display_name: nome } : {}),
          source: "social",
          source_metadata: { origem: "comentario_instagram" },
        },
      );
      const { error } = await admin
        .from("contacts")
        .update({ social_identity: identidade })
        .eq("organization_id", orgId)
        .eq("id", contact.id);
      if (!error) return contact.id;
      // O Direct do mesmo perfil criou o contato no meio do caminho (índice
      // único da identidade): vale o dele. O que acabou de nascer fica sem
      // identidade — registrado para a equipe poder mesclar.
      if (error.code === "23505") {
        logger.warn("automacao: contato do comentário criado em corrida com o Direct", {
          organization_id: orgId,
          contact_id: contact.id,
        });
        const { data } = await admin
          .from("contacts")
          .select("id")
          .eq("organization_id", orgId)
          .eq("social_identity", identidade)
          .is("is_merged_into", null)
          .maybeSingle();
        return (data as { id: string } | null)?.id ?? contact.id;
      }
      throw new Error("contato_do_comentario_sem_identidade");
    },
    iniciar: (input) => iniciarAutomacao(admin, input),
    modoLeitura: (orgId) => contaBloqueadaParaProduzir(admin, orgId),
  };
}

export const automacaoGatilhosHandler: EventHandler = {
  key: AUTOMACAO_GATILHOS_HANDLER_KEY,
  events: [...EVENTOS_DOS_GATILHOS],
  async handle(row): Promise<HandlerResult> {
    try {
      const r = await aplicarGatilhosDeAutomacao(createSupabaseGatilhosDb(createAdminClient()), row);
      return {
        consumer_key: AUTOMACAO_GATILHOS_HANDLER_KEY,
        status: r.iniciadas > 0 ? "ok" : "skipped",
        detail: `avaliadas=${r.avaliadas} iniciadas=${r.iniciadas} ignoradas=${r.ignoradas}`,
      };
    } catch (err) {
      return {
        consumer_key: AUTOMACAO_GATILHOS_HANDLER_KEY,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
