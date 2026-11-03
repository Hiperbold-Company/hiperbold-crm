/**
 * As automações ATIVAS que declaram um tipo de gatilho — para as varreduras de
 * relógio (sem resposta, data do negócio) e para o cron de aniversário, que só
 * trabalham nas organizações que pediram.
 *
 * Os gatilhos moram no grafo da versão publicada (`gatilhosDoGrafo`), então a
 * leitura é: pointers `surface='automacao'` ativos → versões publicadas →
 * gatilhos do Início. Cada versão é lida filtrando a organização do pointer.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { gatilhosDoGrafo } from "./gatilhos";
import type { AutomacaoTrigger, AutomacaoTriggerKind } from "./schemas";

export interface AutomacaoArmada<K extends AutomacaoTriggerKind = AutomacaoTriggerKind> {
  id: string;
  organization_id: string;
  active_version_id: string;
  gatilhos: Array<Extract<AutomacaoTrigger, { kind: K }>>;
}

const LOTE = 100;
/** Linhas por página na leitura dos pointers (abaixo do corte de 1000 do PostgREST). */
export const PAGINA_DE_POINTERS = 500;

export async function automacoesComGatilho<K extends AutomacaoTriggerKind>(
  admin: SupabaseClient,
  kind: K,
  orgId?: string,
): Promise<Array<AutomacaoArmada<K>>> {
  // Paginado: o PostgREST corta em 1000 linhas sem avisar, e uma instalação com
  // muitas organizações perderia as automações depois da milésima.
  const pointers: Array<{ id: string; organization_id: string; active_version_id: string }> = [];
  for (let de = 0; ; de += PAGINA_DE_POINTERS) {
    let consulta = admin
      .from("followup_flow_pointers")
      .select("id, organization_id, active_version_id")
      .eq("surface", "automacao")
      .eq("status", "active")
      .not("active_version_id", "is", null);
    if (orgId) consulta = consulta.eq("organization_id", orgId);
    const { data, error } = await consulta.order("id", { ascending: true }).range(de, de + PAGINA_DE_POINTERS - 1);
    if (error) throw new Error(error.message);
    const pagina = (data ?? []) as typeof pointers;
    pointers.push(...pagina);
    if (pagina.length < PAGINA_DE_POINTERS) break;
  }
  const armadas: Array<AutomacaoArmada<K>> = [];
  for (let i = 0; i < pointers.length; i += LOTE) {
    const fatia = pointers.slice(i, i + LOTE);
    const { data: versoes, error: e2 } = await admin
      .from("followup_flow_versions")
      .select("id, organization_id, graph")
      .in(
        "id",
        fatia.map((p) => p.active_version_id),
      );
    if (e2) throw new Error(e2.message);
    const porId = new Map(
      ((versoes ?? []) as Array<{ id: string; organization_id: string; graph: unknown }>).map(
        (v) => [v.id, v],
      ),
    );
    for (const p of fatia) {
      const v = porId.get(p.active_version_id);
      // A versão tem de ser da MESMA organização do pointer.
      if (!v || v.organization_id !== p.organization_id) continue;
      const cfg = gatilhosDoGrafo(v.graph);
      const gatilhos = (cfg?.triggers ?? []).filter(
        (g): g is Extract<AutomacaoTrigger, { kind: K }> => g.kind === kind,
      );
      if (gatilhos.length > 0) armadas.push({ ...p, gatilhos });
    }
  }
  return armadas;
}

/**
 * Um uuid DETERMINÍSTICO das partes (formato v5, sobre sha-256): a mesma
 * conversa sem resposta depois da mesma mensagem, ou o mesmo negócio na mesma
 * data, dá sempre o mesmo `origin_event_id` — e o `fn_automacao_iniciar`
 * devolve `duplicada` em vez de abrir segunda execução.
 */
export function uuidDeterministico(...partes: string[]): string {
  const h = createHash("sha256").update(partes.join("\u001f")).digest("hex").slice(0, 32).split("");
  h[12] = "5";
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Das origens dadas, as que já abriram execução nesta automação. */
export async function origensJaIniciadas(
  admin: SupabaseClient,
  orgId: string,
  pointerId: string,
  origens: string[],
): Promise<Set<string>> {
  const ja = new Set<string>();
  for (let i = 0; i < origens.length; i += LOTE) {
    const { data, error } = await admin
      .from("followup_enrollments")
      .select("origin_event_id")
      .eq("organization_id", orgId)
      .eq("pointer_id", pointerId)
      .in("origin_event_id", origens.slice(i, i + LOTE));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ origin_event_id: string | null }>) {
      if (r.origin_event_id) ja.add(r.origin_event_id);
    }
  }
  return ja;
}
