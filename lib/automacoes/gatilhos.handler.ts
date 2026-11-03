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
import { createAdminClient } from "@/lib/supabase/admin";

import { AUTOMACAO_GATILHOS_HANDLER_KEY } from "./chaves";
import {
  EVENTOS_DE_AGENDAMENTO_NO_LOG,
  casaGatilho,
  execucaoQueCausou,
  fatosDoEvento,
  gatilhosDoGrafo,
  varsDoGatilho,
  type FatoDeGatilho,
  type FatoDeMensagem,
} from "./gatilhos";
import { iniciarAutomacao, type InicioDaAutomacao } from "./iniciar";
import type { AutomacaoTriggerConfig } from "./schemas";
import { automacaoEsperaRespostaNaConversaSupabase } from "./uma-voz";

export { AUTOMACAO_GATILHOS_HANDLER_KEY } from "./chaves";
export const EVENTOS_DOS_GATILHOS = [
  "lead.created",
  "lead.stage_changed",
  "lead.tag_added",
  "contact.tag_added",
  "contact.birthday",
  "message.received",
  "ai.case_opened",
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
  /** A mensagem é resposta a uma automação esperando NESTA conversa (`uma-voz.ts`)? */
  respostaAAutomacaoNaConversa(orgId: string, conversationId: string): Promise<boolean>;
  /** Nenhuma outra mensagem do contato nesta conversa além desta? */
  primeiraMensagemDaConversa(orgId: string, conversationId: string, messageId: string): Promise<boolean>;
  fonteDeCaptacaoDaOrg(orgId: string, fonteId: string): Promise<boolean>;
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
  }
}

/**
 * Mensagem recebida: as recusas que dependem do banco. Grupo nunca dispara; a
 * resposta a uma automação que espera nesta conversa é DELA, e não inicia
 * outras. Devolve `false` para descartar o evento.
 */
async function mensagemPodeDisparar(
  db: GatilhosDb,
  orgId: string,
  fato: FatoDeMensagem,
  configs: AutomacaoTriggerConfig[],
): Promise<boolean> {
  const gatilhos = configs.flatMap((c) => c.triggers).filter((g) => g.kind === "message_received");
  if (gatilhos.length === 0) return false;
  if ((await db.conversaDeGrupo(orgId, fato.conversation_id)) !== false) return false;
  if (await db.respostaAAutomacaoNaConversa(orgId, fato.conversation_id)) return false;
  if (gatilhos.some((g) => g.kind === "message_received" && g.only_first_message)) {
    fato.primeira_da_conversa = await db.primeiraMensagemDaConversa(orgId, fato.conversation_id, fato.message_id);
  }
  return true;
}

export async function aplicarGatilhosDeAutomacao(db: GatilhosDb, row: EventRow): Promise<ResumoDosGatilhos> {
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
  if (mensagem && !(await mensagemPodeDisparar(db, row.organization_id, mensagem, armadas.map((a) => a.cfg)))) {
    return resumo;
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
    if (contato === undefined) contato = await contatoDoFato(db, row.organization_id, fato);
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
    respostaAAutomacaoNaConversa: (orgId, conversationId) =>
      automacaoEsperaRespostaNaConversaSupabase(admin, { organizationId: orgId, conversationId }),
    async primeiraMensagemDaConversa(orgId, conversationId, messageId) {
      const { data, error } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("direction", "inbound")
        .neq("id", messageId)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length === 0;
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
