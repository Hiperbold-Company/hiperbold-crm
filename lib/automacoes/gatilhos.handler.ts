/**
 * Handler do `event_log` que INICIA automações (`automacao-gatilhos.v1`).
 *
 * Para cada evento de lead (criado, mudou de etapa): lê as automações ATIVAS da
 * organização (índice `(organization_id, surface, status)`, 0986), confere os
 * gatilhos do grafo publicado (cache por `version_id` — versão é imutável) e
 * chama `fn_automacao_iniciar` com `origin_event_id` = a linha do evento: um
 * re-drain do mesmo evento não abre segunda execução.
 *
 * Anti-laço: o evento causado por uma automação não dispara a MESMA automação
 * (`request_id = automacao:<pointer>:…`). Organização em modo leitura não
 * inicia nada (mesma regra dos gatilhos de follow-up). Trigger Postgres nunca
 * faz HTTP: tudo aqui roda no worker.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { contaBloqueadaParaProduzir } from "@/lib/billing/assinatura/pode-produzir";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

import { casaGatilho, fatosDoEvento, gatilhosDoGrafo, varsDoGatilho } from "./gatilhos";
import { iniciarAutomacao, type InicioDaAutomacao } from "./iniciar";
import type { AutomacaoTriggerConfig } from "./schemas";

export const AUTOMACAO_GATILHOS_HANDLER_KEY = "automacao-gatilhos.v1";
export const EVENTOS_DOS_GATILHOS = ["lead.created", "lead.stage_changed"] as const;

export interface GatilhosDb {
  automacoesAtivas(orgId: string): Promise<Array<{ id: string; active_version_id: string }>>;
  gatilhosDaVersao(orgId: string, versionId: string): Promise<AutomacaoTriggerConfig | null>;
  contatoDoNegocio(orgId: string, leadId: string): Promise<string | null>;
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

export async function aplicarGatilhosDeAutomacao(db: GatilhosDb, row: EventRow): Promise<ResumoDosGatilhos> {
  const resumo: ResumoDosGatilhos = { avaliadas: 0, iniciadas: 0, ignoradas: 0 };
  const fatos = fatosDoEvento(row);
  if (fatos.length === 0) return resumo;

  const automacoes = await db.automacoesAtivas(row.organization_id);
  if (automacoes.length === 0) return resumo;
  if (await db.modoLeitura(row.organization_id)) return resumo;

  let contato: string | null | undefined;
  let fonteConfirmada: boolean | undefined;
  for (const a of automacoes) {
    resumo.avaliadas++;
    const cfg = await db.gatilhosDaVersao(row.organization_id, a.active_version_id);
    if (!cfg) continue;
    // Fonte de captação: conferida no banco uma vez, e só quando um gatilho depende dela.
    const dependeDeFonte = cfg.triggers.some(
      (g) => g.kind === "lead_created" && (g.only_capture === true || (g.capture_source_ids?.length ?? 0) > 0),
    );
    const fonteDoEvento = fatos.find((f) => f.fonte_id !== null)?.fonte_id ?? null;
    if (dependeDeFonte && fonteConfirmada === undefined) {
      fonteConfirmada = fonteDoEvento ? await db.fonteDeCaptacaoDaOrg(row.organization_id, fonteDoEvento) : false;
    }
    const fato = fatos.find(
      (f) => f.causado_pela_automacao !== a.id && cfg.triggers.some((g) => casaGatilho(g, f, fonteConfirmada === true)),
    );
    if (!fato) continue;
    if (contato === undefined) contato = await db.contatoDoNegocio(row.organization_id, fato.lead_id);
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
