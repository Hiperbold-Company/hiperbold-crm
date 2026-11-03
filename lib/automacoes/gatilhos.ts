/**
 * GATILHOS das automações. Lote 1: manual, lead criado (inclui "veio de fonte
 * de captação") e entrou na etapa (criado ou movido). Lote 3: mensagem
 * recebida, tag adicionada, agendamento, aniversário, caso aberto na Central
 * (eventos do `event_log`), e data de campo do negócio e sem resposta
 * (varreduras de relógio: `varredura-de-data.ts`, `varredura-sem-resposta.ts`).
 *
 * Os gatilhos moram no nó Início do GRAFO publicado (vários por automação), não
 * numa tabela de projeção: a versão é imutável, então ler o grafo é ler a
 * verdade (DIRC — calcular em vez de duplicar).
 *
 * Esta parte é PURA: projeta a linha do `event_log` num fato de gatilho e
 * decide se um gatilho casa. O handler (`gatilhos.handler.ts`) faz o I/O.
 */
import type { EventRow } from "@/lib/event-log/dispatcher";
import { ORIGEM_DA_PLANILHA } from "@/lib/leads/planilha";
import {
  automacaoTriggerConfigSchema,
  type AutomacaoTrigger,
  type AutomacaoTriggerConfig,
  type EventoDeAgendamento,
} from "./schemas";
import { inboundContaComoResposta } from "./conversa";
import { flowGraphSchema } from "@/lib/followup/graph-schema";


interface ComumDoFato {
  /** O pointer que causou o evento, quando foi uma automação (anti-laço). */
  causado_pela_automacao: string | null;
}

export interface FatoDeNegocio extends ComumDoFato {
  tipo: "lead_created" | "stage_entered_created" | "stage_entered_moved";
  lead_id: string;
  pipeline_id: string | null;
  stage_id: string | null;
  from_stage_id: string | null;
  /** `webhook_sources.id` quando o negócio entrou por uma fonte de captação (a confirmar no banco). */
  fonte_id: string | null;
}

export interface FatoDeMensagem extends ComumDoFato {
  tipo: "message_received";
  message_id: string;
  conversation_id: string;
  contact_id: string;
  channel_session_id: string | null;
  /** `body_preview` do evento (até 280). Só vai para `vars`, nunca para eventos da execução (LGPD). */
  texto: string;
  /** Preenchido pelo handler só quando um gatilho pede "só a primeira mensagem". */
  primeira_da_conversa?: boolean;
}

export interface FatoDeTag extends ComumDoFato {
  tipo: "tag_added";
  alvo: "lead" | "contact";
  lead_id: string | null;
  contact_id: string | null;
  tags: string[];
}

export interface FatoDeAgendamento extends ComumDoFato {
  tipo: "appointment";
  evento: EventoDeAgendamento;
  appointment_id: string;
  inicio: string | null;
  fim: string | null;
  nome_do_tipo: string | null;
  lead_id: string | null;
}

export interface FatoDeAniversario extends ComumDoFato {
  tipo: "birthday";
  contact_id: string;
  data: string | null;
}

export interface FatoDeCaso extends ComumDoFato {
  tipo: "case_opened";
  case_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
}

export type FatoDeGatilho =
  | FatoDeNegocio
  | FatoDeMensagem
  | FatoDeTag
  | FatoDeAgendamento
  | FatoDeAniversario
  | FatoDeCaso;

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOuNulo(v: unknown): string | null {
  const t = texto(v);
  return t && UUID.test(t) ? t : null;
}

/** Quem causou o evento, se foi uma automação: `request_id = automacao:<pointer>:…`. */
export function automacaoQueCausou(row: Pick<EventRow, "metadata">): string | null {
  const rid = texto(row.metadata?.request_id);
  if (rid?.startsWith("automacao:")) return rid.split(":")[1] ?? null;
  const c = row.metadata?.caused_by_automation as { pointer_id?: unknown } | undefined;
  return texto(c?.pointer_id);
}

/**
 * O evento foi causado por uma REGRA antiga (`lib/automation`)? Então não
 * inicia automação nenhuma: as regras e as automações são dois motores, e um
 * disparando o outro é laço que nenhum dos dois freios enxerga inteiro (o
 * `fn_automacao_iniciar` só mede a cadeia entre automações).
 */
export function causadoPorRegra(row: Pick<EventRow, "metadata">): boolean {
  if (texto(row.metadata?.caused_by_rule)) return true;
  return texto(row.metadata?.request_id)?.startsWith("rule:") === true;
}

/**
 * A EXECUÇÃO de automação que causou o evento (`request_id =
 * automacao:<pointer>:<execução>:…`, ou `caused_by_automation.enrollment_id`).
 * Vira o `parent_enrollment_id` da execução que o evento iniciar: é assim que a
 * cadeia A → B → A é medida e cortada (`fn_automacao_iniciar`).
 */
export function execucaoQueCausou(row: Pick<EventRow, "metadata">): string | null {
  const rid = texto(row.metadata?.request_id);
  if (rid?.startsWith("automacao:")) {
    const id = rid.split(":")[2] ?? "";
    return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  }
  const c = row.metadata?.caused_by_automation as { enrollment_id?: unknown } | undefined;
  const id = texto(c?.enrollment_id);
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** Os eventos do `event_log` que o handler das automações assina. */
export const EVENTOS_DE_AGENDAMENTO_NO_LOG: Record<`appointment.${EventoDeAgendamento}`, EventoDeAgendamento> = {
  "appointment.created": "created",
  "appointment.confirmed": "confirmed",
  "appointment.rescheduled": "rescheduled",
  "appointment.cancelled": "cancelled",
  "appointment.completed": "completed",
  "appointment.no_show": "no_show",
};

function tagsDoPayload(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
}

/** Os fatos de gatilho que UMA linha do event_log produz (lead criado também é "entrou na etapa"). */
export function fatosDoEvento(row: EventRow): FatoDeGatilho[] {
  // Anti-laço com o motor antigo: o que uma regra causou não inicia automação.
  if (causadoPorRegra(row)) return [];
  const causado = automacaoQueCausou(row);
  const entidade = texto(row.entity_id);

  if (row.entity_kind === "crm_lead" && entidade) {
    const leadId = entidade;
    if (row.event_type === "lead.created") {
      // Planilha importada não dispara automação (mesma regra do gatilho de lead dos follow-ups).
      if (row.metadata?.via === ORIGEM_DA_PLANILHA) return [];
      const fonte = row.metadata?.actor_type === "webhook_source" && !causado ? texto(row.metadata?.actor_id) : null;
      const base = {
        lead_id: leadId,
        pipeline_id: texto(row.payload.pipeline_id),
        stage_id: texto(row.payload.stage_id),
        from_stage_id: null,
        fonte_id: fonte,
        causado_pela_automacao: causado,
      };
      return [
        { ...base, tipo: "lead_created" },
        { ...base, tipo: "stage_entered_created" },
      ];
    }
    if (row.event_type === "lead.stage_changed") {
      const para = texto(row.payload.to_stage_id);
      if (!para) return [];
      return [
        {
          tipo: "stage_entered_moved",
          lead_id: leadId,
          pipeline_id: texto(row.payload.pipeline_id),
          stage_id: para,
          from_stage_id: texto(row.payload.from_stage_id),
          fonte_id: null,
          causado_pela_automacao: causado,
        },
      ];
    }
    if (row.event_type === "lead.tag_added") {
      const tags = tagsDoPayload(row.payload.added_tags);
      if (tags.length === 0) return [];
      return [{ tipo: "tag_added", alvo: "lead", lead_id: leadId, contact_id: null, tags, causado_pela_automacao: causado }];
    }
    return [];
  }

  if (row.entity_kind === "contact" && entidade) {
    if (row.event_type === "contact.tag_added") {
      const tags = tagsDoPayload(row.payload.added_tags);
      if (tags.length === 0) return [];
      return [
        { tipo: "tag_added", alvo: "contact", lead_id: null, contact_id: entidade, tags, causado_pela_automacao: causado },
      ];
    }
    if (row.event_type === "contact.birthday") {
      return [{ tipo: "birthday", contact_id: entidade, data: texto(row.payload.local_date), causado_pela_automacao: causado }];
    }
    return [];
  }

  if (row.entity_kind === "message" && row.event_type === "message.received") {
    // Só o que o CONTATO escreveu: saída (inclusive o eco do nosso envio pelo
    // aparelho, `fromMe`) nunca é "mensagem recebida". Reação e tipo não
    // suportado também não: o contato não disse nada.
    if (row.payload.direction !== "inbound") return [];
    const messageId = uuidOuNulo(row.payload.message_id) ?? uuidOuNulo(entidade);
    const conversa = uuidOuNulo(row.payload.conversation_id);
    const contato = uuidOuNulo(row.payload.contact_id);
    if (!messageId || !conversa || !contato) return [];
    const corpo = typeof row.payload.body_preview === "string" ? row.payload.body_preview : "";
    if (!inboundContaComoResposta({ type: texto(row.payload.type), body: corpo })) return [];
    return [
      {
        tipo: "message_received",
        message_id: messageId,
        conversation_id: conversa,
        contact_id: contato,
        channel_session_id: uuidOuNulo(row.payload.channel_session_id),
        texto: corpo.slice(0, 280),
        causado_pela_automacao: causado,
      },
    ];
  }

  if (row.entity_kind === "calendar_appointment" && entidade && row.event_type in EVENTOS_DE_AGENDAMENTO_NO_LOG) {
    const evento = EVENTOS_DE_AGENDAMENTO_NO_LOG[row.event_type as keyof typeof EVENTOS_DE_AGENDAMENTO_NO_LOG];
    const leads = tagsDoPayload(row.payload.lead_ids).filter((id) => UUID.test(id));
    const tipoDoCompromisso = row.payload.tipo as { nome?: unknown } | undefined;
    return [
      {
        tipo: "appointment",
        evento,
        appointment_id: entidade,
        inicio: texto(row.payload.inicio),
        fim: texto(row.payload.fim),
        nome_do_tipo: texto(tipoDoCompromisso?.nome) ?? texto(row.payload.event_type_name),
        lead_id: leads.length === 1 ? leads[0]! : null,
        causado_pela_automacao: causado,
      },
    ];
  }

  if (row.entity_kind === "agent_case" && entidade && row.event_type === "ai.case_opened") {
    return [
      {
        tipo: "case_opened",
        case_id: entidade,
        conversation_id: uuidOuNulo(row.payload.conversation_id),
        contact_id: uuidOuNulo(row.payload.contact_id),
        lead_id: uuidOuNulo(row.payload.lead_id),
        causado_pela_automacao: causado,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Palavra-chave
// ---------------------------------------------------------------------------

/**
 * Texto para comparar palavra-chave: sem acento, minúsculo, pontuação vira
 * espaço e espaços repetidos viram um. "Olá, QUERO o preço!" → "ola quero o preco".
 */
export function normalizarParaPalavraChave(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * A mensagem casa a palavra-chave? Decisão: comparação por PALAVRA ou FRASE
 * inteira, nunca por pedaço de palavra — "oi" não casa "oito", "preço" casa
 * "qual o preço?". `starts_with` também exige o fim da palavra ("oi tudo bem"
 * começa com "oi"; "oitava" não). Sem acento e sem maiúsculas dos dois lados.
 */
export function palavraChaveCasa(
  modo: "any" | "contains" | "equals" | "starts_with",
  palavras: readonly string[],
  mensagem: string,
): boolean {
  if (modo === "any") return true;
  const t = normalizarParaPalavraChave(mensagem);
  if (!t) return false;
  return palavras.some((bruta) => {
    const p = normalizarParaPalavraChave(bruta);
    if (!p) return false;
    if (modo === "equals") return t === p;
    if (modo === "starts_with") return t === p || t.startsWith(`${p} `);
    return ` ${t} `.includes(` ${p} `);
  });
}

function mesmaTag(a: string, b: string): boolean {
  return normalizarParaPalavraChave(a) === normalizarParaPalavraChave(b);
}

/**
 * O gatilho casa com o fato? `fonteConfirmada` diz se `fato.fonte_id` é mesmo
 * uma fonte de captação da organização (quem confere é o handler, no banco).
 */
export function casaGatilho(gatilho: AutomacaoTrigger, fato: FatoDeGatilho, fonteConfirmada: boolean): boolean {
  switch (gatilho.kind) {
    case "manual":
      return false;
    case "lead_created": {
      if (fato.tipo !== "lead_created") return false;
      if (gatilho.pipeline_ids?.length && (!fato.pipeline_id || !gatilho.pipeline_ids.includes(fato.pipeline_id))) {
        return false;
      }
      if (gatilho.capture_source_ids?.length) {
        return fonteConfirmada && fato.fonte_id !== null && gatilho.capture_source_ids.includes(fato.fonte_id);
      }
      if (gatilho.only_capture) return fonteConfirmada && fato.fonte_id !== null;
      return true;
    }
    case "stage_entered": {
      if (fato.tipo !== "stage_entered_created" && fato.tipo !== "stage_entered_moved") return false;
      if (!fato.stage_id || !gatilho.stage_ids.includes(fato.stage_id)) return false;
      if (fato.tipo === "stage_entered_created") return gatilho.via !== "moved";
      // Movimento para a MESMA etapa não é entrada.
      if (fato.from_stage_id === fato.stage_id) return false;
      return gatilho.via !== "created";
    }
    case "message_received": {
      if (fato.tipo !== "message_received") return false;
      if (
        gatilho.channel_session_ids?.length &&
        (!fato.channel_session_id || !gatilho.channel_session_ids.includes(fato.channel_session_id))
      ) {
        return false;
      }
      if (gatilho.only_first_message && fato.primeira_da_conversa !== true) return false;
      return palavraChaveCasa(gatilho.match, gatilho.keywords, fato.texto);
    }
    case "tag_added":
      return (
        fato.tipo === "tag_added" &&
        fato.alvo === gatilho.target &&
        fato.tags.some((t) => gatilho.tags.some((g) => mesmaTag(t, g)))
      );
    case "appointment":
      return fato.tipo === "appointment" && gatilho.events.includes(fato.evento);
    case "birthday":
      return fato.tipo === "birthday";
    case "case_opened":
      return fato.tipo === "case_opened";
    // Varreduras de relógio: nenhum evento do log os casa.
    case "date_field":
    case "no_reply":
      return false;
  }
}

/** Os gatilhos declarados no Início de um grafo publicado, ou `null` se não é grafo de automação. */
export function gatilhosDoGrafo(grafo: unknown): AutomacaoTriggerConfig | null {
  const parsed = flowGraphSchema.safeParse(grafo);
  if (!parsed.success) return null;
  const inicio = parsed.data.nodes.find((n) => n.type === "trigger");
  if (!inicio) return null;
  const cfg = automacaoTriggerConfigSchema.safeParse(inicio.config);
  return cfg.success ? cfg.data : null;
}

/**
 * O que a execução guarda do gatilho em `vars.gatilho` — projeção curta. O
 * texto da mensagem (até 280) só mora aqui: `vars` é zerado na anonimização e
 * nunca vai para os eventos da execução (o `fn_automacao_iniciar` grava só o
 * `tipo`). `_lead_id` é o negócio que os blocos de CRM usam quando o gatilho o
 * conhece.
 */
export function varsDoGatilho(fato: FatoDeGatilho, eventId: string): Record<string, unknown> {
  const comLead = (leadId: string | null, gatilho: Record<string, unknown>) => ({
    ...(leadId ? { _lead_id: leadId } : {}),
    gatilho: { ...gatilho, event_id: eventId },
  });
  switch (fato.tipo) {
    case "lead_created":
    case "stage_entered_created":
    case "stage_entered_moved":
      return comLead(fato.lead_id, {
        tipo: fato.tipo === "lead_created" ? "lead_created" : "stage_entered",
        lead_id: fato.lead_id,
        pipeline_id: fato.pipeline_id,
        stage_id: fato.stage_id,
        ...(fato.from_stage_id ? { from_stage_id: fato.from_stage_id } : {}),
        ...(fato.fonte_id ? { fonte_id: fato.fonte_id } : {}),
      });
    case "message_received":
      return comLead(null, {
        tipo: "message_received",
        message_id: fato.message_id,
        conversation_id: fato.conversation_id,
        channel_session_id: fato.channel_session_id,
        texto: fato.texto.slice(0, 280),
      });
    case "tag_added":
      return comLead(fato.lead_id, {
        tipo: "tag_added",
        alvo: fato.alvo,
        tags: fato.tags.slice(0, 20),
        ...(fato.lead_id ? { lead_id: fato.lead_id } : {}),
      });
    case "appointment":
      return comLead(fato.lead_id, {
        tipo: "appointment",
        evento: fato.evento,
        appointment_id: fato.appointment_id,
        inicio: fato.inicio,
        fim: fato.fim,
        ...(fato.nome_do_tipo ? { nome_do_tipo: fato.nome_do_tipo } : {}),
        ...(fato.lead_id ? { lead_id: fato.lead_id } : {}),
      });
    case "birthday":
      return comLead(null, { tipo: "birthday", data: fato.data });
    case "case_opened":
      return comLead(fato.lead_id, {
        tipo: "case_opened",
        case_id: fato.case_id,
        conversation_id: fato.conversation_id,
        ...(fato.lead_id ? { lead_id: fato.lead_id } : {}),
      });
  }
}
