import type { Lead } from "@/lib/types/leads";
import { cardTemMarcador } from "@/lib/kanban/marcadores-do-card";
import {
  dentroDoFiltroDeData,
  filtroDeDataFromParams,
  filtroDeDataToParams,
  ultimaMovimentacao,
  type FiltroDeData,
} from "@/lib/kanban/datas-do-lead";

/**
 * Prefixo que marca um dono AGENTE no filtro (0070). O param de URL continua
 * sendo `owner=` — humano é o uuid puro, agente é `agent:<uuid>`, e o board
 * não precisa de dois seletores para a mesma pergunta ("de quem é isto?").
 */
export const AGENT_OWNER_PREFIX = "agent:";

export function agentOwnerFilter(agentId: string): string {
  return `${AGENT_OWNER_PREFIX}${agentId}`;
}

export function parseAgentOwnerFilter(value: string | undefined): string | null {
  if (!value?.startsWith(AGENT_OWNER_PREFIX)) return null;
  return value.slice(AGENT_OWNER_PREFIX.length) || null;
}

/**
 * O filtro "Eventos manuais": quantos eventos o negócio tem registrados À MÃO
 * ("Registrar evento" da ficha — `crm_lead_activities` com `type = 'note'` e
 * `source_module = 'manual'`, ver `lib/leads/evento-manual.ts`). A contagem vem
 * do banco (`GET /api/v1/pipelines/[id]/eventos-manuais`, migration 0979); aqui
 * só se compara.
 */
export type OperadorDeEventosManuais = "lt" | "eq" | "gt";
export const OPERADORES_DE_EVENTOS_MANUAIS: readonly OperadorDeEventosManuais[] = [
  "lt",
  "eq",
  "gt",
];
export interface FiltroDeEventosManuais {
  op: OperadorDeEventosManuais;
  /** Inteiro ≥ 0. */
  n: number;
}

/** O negócio com `total` eventos manuais passa no filtro? */
export function atendeEventosManuais(total: number, filtro: FiltroDeEventosManuais): boolean {
  if (filtro.op === "lt") return total < filtro.n;
  if (filtro.op === "eq") return total === filtro.n;
  return total > filtro.n;
}

/** `eventos=gt:5` na URL. Valor malformado é filtro AUSENTE, nunca um número inventado. */
export function filtroDeEventosManuaisFromParam(
  valor: string | null | undefined,
): FiltroDeEventosManuais | undefined {
  const m = /^(lt|eq|gt):(\d{1,6})$/.exec(valor ?? "");
  if (!m) return undefined;
  return { op: m[1] as OperadorDeEventosManuais, n: Number(m[2]) };
}

export function filtroDeEventosManuaisToParam(filtro: FiltroDeEventosManuais): string {
  return `${filtro.op}:${filtro.n}`;
}

export interface LeadFilters {
  /** userId | `agent:<uuid>` | "any" | "unassigned" */
  owner?: string | "any" | "unassigned";
  status?: "all" | "open" | "won" | "lost";
  tag?: string;
  search?: string;
  valueCentsMin?: number | null;
  valueCentsMax?: number | null;
  overdueOnly?: boolean;
  /** O `lost_reason` exato do card — filtro de perda (issue #1537). */
  lostReason?: string;
  /** A categoria do motivo de perda (issue #1537), resolvida no funil. */
  lostCategory?: string;
  /** "Criado em" (`crm_leads.created_at`): atalho ou período, no fuso da organização. */
  createdAt?: FiltroDeData;
  /** "Última movimentação" (`stage_changed_at`, ou `created_at` se nulo). */
  movedAt?: FiltroDeData;
  /** "Eventos manuais": operador + número (ver `FiltroDeEventosManuais`). */
  manualEvents?: FiltroDeEventosManuais;
}

/**
 * Serializa/deserializa os filtros do board em query params (deep-linkável).
 * Só os controles expostos na FilterBar: owner, status, tag, busca, atrasados.
 */
export function filtersFromParams(
  sp: { get(key: string): string | null },
): LeadFilters {
  const owner = sp.get("owner");
  const status = sp.get("status");
  const tag = sp.get("tag");
  const search = sp.get("q");
  return {
    owner: owner ?? undefined,
    status:
      status === "open" || status === "won" || status === "lost" || status === "all"
        ? status
        : "all",
    tag: tag ?? undefined,
    search: search ?? undefined,
    overdueOnly: sp.get("overdue") === "1" || undefined,
    lostReason: sp.get("motivo") ?? undefined,
    lostCategory: sp.get("categoria") ?? undefined,
    createdAt: filtroDeDataFromParams(sp, "criado"),
    movedAt: filtroDeDataFromParams(sp, "mov"),
    manualEvents: filtroDeEventosManuaisFromParam(sp.get("eventos")),
  };
}

export function filtersToParams(f: LeadFilters): string {
  const p = new URLSearchParams();
  if (f.owner && f.owner !== "any") p.set("owner", f.owner);
  if (f.status && f.status !== "all") p.set("status", f.status);
  if (f.tag) p.set("tag", f.tag);
  if (f.search?.trim()) p.set("q", f.search.trim());
  if (f.overdueOnly) p.set("overdue", "1");
  if (f.lostReason) p.set("motivo", f.lostReason);
  if (f.lostCategory) p.set("categoria", f.lostCategory);
  filtroDeDataToParams(p, "criado", f.createdAt);
  filtroDeDataToParams(p, "mov", f.movedAt);
  if (f.manualEvents) p.set("eventos", filtroDeEventosManuaisToParam(f.manualEvents));
  return p.toString();
}

/**
 * `contexto` é o que a tela sabe e o lead não: a categoria NÃO é coluna, ela
 * sai do `settings.lost_reasons` do funil (`lib/leads/motivos-de-perda-do-funil.ts`).
 * Sem contexto, filtrar por categoria não acha nada — que é o comportamento
 * honesto: sem configuração não há o que agrupar.
 */
export interface ContextoDosFiltros {
  categoriaDo?: (motivo: string) => string | undefined;
  /** Fuso IANA DA ORGANIZAÇÃO: é nele que "hoje" e "este mês" são contados. */
  timezone?: string | null;
  /** "Agora" injetável, para o teste não depender do relógio. */
  agora?: Date;
  /**
   * Eventos manuais por negócio, como o servidor contou (negócio ausente = 0).
   * `undefined` = a contagem ainda não chegou: o filtro de eventos NÃO se aplica,
   * em vez de tratar todo mundo como zero e esvaziar o quadro por um instante.
   */
  eventosManuais?: ReadonlyMap<string, number>;
}

export function applyFilters(
  leads: Lead[],
  f: LeadFilters,
  contexto?: ContextoDosFiltros,
): Lead[] {
  const today = new Date().toISOString().slice(0, 10);
  // Um "agora" por varredura, e não por card.
  const agora = contexto?.agora ?? new Date();
  const search = f.search?.trim().toLowerCase() ?? "";

  return leads.filter((l) => {
    // "Sem responsável" é sem dono NENHUM — lead de dono agente tem dono.
    if (
      f.owner === "unassigned" &&
      (l.owner_user_id !== null || l.owner_agent_id !== null)
    )
      return false;
    if (f.owner && f.owner !== "any" && f.owner !== "unassigned") {
      const agentId = parseAgentOwnerFilter(f.owner);
      if (agentId) {
        if (l.owner_agent_id !== agentId) return false;
      } else if (l.owner_user_id !== f.owner) {
        return false;
      }
    }
    if (f.status && f.status !== "all" && l.status !== f.status) return false;
    // Motivo/categoria só existem em negócio PERDIDO (issue #1537). Escolher um
    // deles é pedir perdas: sem isso, o filtro combinado com a aba "Ganhos"
    // devolvia lista vazia sem dizer por quê.
    if ((f.lostReason || f.lostCategory) && l.status !== "lost") return false;
    if (f.lostReason && l.lost_reason !== f.lostReason) return false;
    if (f.lostCategory) {
      const motivo = l.lost_reason?.trim() ?? "";
      const categoria = motivo ? contexto?.categoriaDo?.(motivo) : undefined;
      if (categoria !== f.lostCategory) return false;
    }
    // As TRÊS caixas de marcador (negócio, contato, conversa) — ver
    // lib/kanban/marcadores-do-card.ts. Só `l.tags` deixava o marcador escrito
    // no contato ou na conversa sem casar card nenhum.
    if (f.tag && !cardTemMarcador(l, f.tag)) return false;
    if (
      search &&
      !`${l.title} ${l.description ?? ""}`.toLowerCase().includes(search)
    )
      return false;
    if (typeof f.valueCentsMin === "number" && (l.value_cents ?? 0) < f.valueCentsMin)
      return false;
    if (typeof f.valueCentsMax === "number" && (l.value_cents ?? 0) > f.valueCentsMax)
      return false;
    if (!dentroDoFiltroDeData(l.created_at, f.createdAt, agora, contexto?.timezone)) return false;
    if (!dentroDoFiltroDeData(ultimaMovimentacao(l), f.movedAt, agora, contexto?.timezone)) return false;
    if (f.manualEvents && contexto?.eventosManuais) {
      const total = contexto.eventosManuais.get(l.id) ?? 0;
      if (!atendeEventosManuais(total, f.manualEvents)) return false;
    }
    if (f.overdueOnly) {
      if (l.status !== "open") return false;
      if (!l.expected_close_date || l.expected_close_date >= today) return false;
    }
    return true;
  });
}
