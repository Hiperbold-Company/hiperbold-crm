/**
 * Handler do `event_log` que leva o DESFECHO das respostas do Instagram ao
 * histórico da execução (`automacao-desfecho-da-resposta.v1`).
 *
 * O bloco "Responder em privado" / "Responder no comentário" só PEDE a resposta
 * (vai para a fila do canal e sai na rodada seguinte do cron). Quando a fila a
 * leva a um estado final, o canal emite `instagram.resposta_enviada` ou
 * `instagram.resposta_falhou` (contrato, seção 4-A) com o `pedido_por` que a
 * automação mandou: `automacao:<pointer>:<execução>:<nó>:<passo>`
 * (`requestId` de `efeitos/index.ts`, cortado em 200 pelo canal).
 *
 * Aqui só se ESCREVE UMA LINHA no histórico ("Resposta privada saiu" /
 * "Resposta privada falhou: <motivo>"). O caminho que o bloco já tomou não
 * muda: a saída dele foi escolhida pelo status do pedido, e reescrever o grafo
 * por um evento atrasado faria a execução andar para trás.
 *
 * A linha é gravada com o `node_id` ATUAL da execução (o mesmo desenho do
 * `inbound_woke` da reatividade): o motor lê a estadia do nó atual de trás para
 * frente e para no primeiro evento de outro nó — gravar com o nó do bloco do
 * Instagram faria a espera que veio depois dele "esquecer" que já estacionou.
 * O nó do bloco vai no payload (`no_id`).
 *
 * `pedido_por` nulo ou de outra origem: ignorado. A execução é procurada pela
 * organização da LINHA do `event_log` (que o canal tirou da sessão), conferida
 * contra a do payload, e pelo pointer do `pedido_por`: id de outra organização
 * se comporta como inexistente (service role ignora RLS).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

import { EVENTO_RESPOSTA_ENVIADA, EVENTO_RESPOSTA_FALHOU } from "./canal-de-comentarios";
import { EVENTO_DA_EXECUCAO_RESPOSTA_FALHOU, EVENTO_DA_EXECUCAO_RESPOSTA_SAIU } from "./chaves";

export const AUTOMACAO_DESFECHO_DA_RESPOSTA_HANDLER_KEY = "automacao-desfecho-da-resposta.v1";

/** Os `event_type` que esta linha ganha em `followup_enrollment_events`. */
export { EVENTO_DA_EXECUCAO_RESPOSTA_FALHOU, EVENTO_DA_EXECUCAO_RESPOSTA_SAIU } from "./chaves";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PedidoDaAutomacao {
  pointerId: string;
  enrollmentId: string;
  /** O nó do bloco que pediu (`null` quando o corte de 200 caracteres o comeu). */
  noId: string | null;
}

/** Lê `automacao:<pointer>:<execução>:<nó>:<passo>`; `null` para qualquer outra origem. */
export function lerPedidoDaAutomacao(pedidoPor: unknown): PedidoDaAutomacao | null {
  if (typeof pedidoPor !== "string") return null;
  const partes = pedidoPor.split(":");
  if (partes.length < 3 || partes[0] !== "automacao") return null;
  const pointerId = partes[1]!;
  const enrollmentId = partes[2]!;
  if (!UUID.test(pointerId) || !UUID.test(enrollmentId)) return null;
  // O resto é `<nó>:<passo>`; o nó pode ter `:` — o passo é o último pedaço.
  const resto = partes.slice(3);
  const noId = resto.length >= 2 ? resto.slice(0, -1).join(":") : null;
  return { pointerId, enrollmentId, noId: noId && noId.length > 0 ? noId : null };
}

export interface DesfechoDb {
  /** O nó atual da execução, ou `null` quando ela não existe NESTA organização com este pointer. */
  noAtualDaExecucao(orgId: string, pointerId: string, enrollmentId: string): Promise<string | null>;
  /** Insere o evento; `false` quando a chave já existia (re-drain). */
  inserirEvento(evento: {
    organization_id: string;
    enrollment_id: string;
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<boolean>;
}

export type ResultadoDoDesfecho = "gravado" | "ja_gravado" | "ignorado";

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function aplicarDesfechoDaResposta(db: DesfechoDb, row: EventRow): Promise<ResultadoDoDesfecho> {
  if (row.event_type !== EVENTO_RESPOSTA_ENVIADA && row.event_type !== EVENTO_RESPOSTA_FALHOU) return "ignorado";
  const p = row.payload ?? {};
  // A organização é a da linha; o payload tem de concordar com ela.
  const org = row.organization_id;
  if (!org || texto(p.organization_id) !== org) return "ignorado";
  const pedido = lerPedidoDaAutomacao(p.pedido_por);
  if (!pedido) return "ignorado";
  const tipo = p.tipo === "resposta_publica" ? "resposta_publica" : p.tipo === "resposta_privada" ? "resposta_privada" : null;
  if (!tipo) return "ignorado";

  const noAtual = await db.noAtualDaExecucao(org, pedido.pointerId, pedido.enrollmentId);
  if (!noAtual) return "ignorado";

  const saiu = row.event_type === EVENTO_RESPOSTA_ENVIADA;
  const motivo = saiu ? null : texto(p.motivo);
  const inseriu = await db.inserirEvento({
    organization_id: org,
    enrollment_id: pedido.enrollmentId,
    node_id: noAtual,
    event_type: saiu ? EVENTO_DA_EXECUCAO_RESPOSTA_SAIU : EVENTO_DA_EXECUCAO_RESPOSTA_FALHOU,
    // Só códigos: nunca o texto da resposta nem o do comentário.
    payload: { tipo, ...(pedido.noId ? { no_id: pedido.noId } : {}), ...(motivo ? { motivo } : {}) },
    // Uma linha por evento do canal. Não termina em `:<número>` (essa forma é
    // a chave de PASSO do motor, ver `fn_followup_generation_write`).
    idempotency_key: `ig_desfecho:${row.id}`,
  });
  return inseriu ? "gravado" : "ja_gravado";
}

export function createSupabaseDesfechoDb(admin: SupabaseClient): DesfechoDb {
  return {
    async noAtualDaExecucao(orgId, pointerId, enrollmentId) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("current_node_id")
        .eq("organization_id", orgId)
        .eq("id", enrollmentId)
        .eq("pointer_id", pointerId)
        .eq("lane", "automacao")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return texto((data as { current_node_id?: unknown } | null)?.current_node_id);
    },
    async inserirEvento(evento) {
      const { error } = await admin.from("followup_enrollment_events").insert(evento);
      if (error) {
        if (error.code === "23505") return false;
        throw new Error(error.message);
      }
      return true;
    },
  };
}

export const automacaoDesfechoDaRespostaHandler: EventHandler = {
  key: AUTOMACAO_DESFECHO_DA_RESPOSTA_HANDLER_KEY,
  events: [EVENTO_RESPOSTA_ENVIADA, EVENTO_RESPOSTA_FALHOU],
  async handle(row): Promise<HandlerResult> {
    try {
      const r = await aplicarDesfechoDaResposta(createSupabaseDesfechoDb(createAdminClient()), row);
      return {
        consumer_key: AUTOMACAO_DESFECHO_DA_RESPOSTA_HANDLER_KEY,
        status: r === "gravado" ? "ok" : "skipped",
        detail: r,
      };
    } catch (err) {
      return {
        consumer_key: AUTOMACAO_DESFECHO_DA_RESPOSTA_HANDLER_KEY,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
