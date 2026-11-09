/**
 * GET/POST /api/v1/cron/routing-worker — G5-02 (AT-03, spec 13 §5).
 *
 * Drena `conversation.routing_requested` do event_log e distribui conversas sem
 * dono segundo o modo da org (manual = no-op; round_robin = rodízio entre
 * elegíveis). Trigger NUNCA faz HTTP — a emissão é um trigger AFTER INSERT em
 * conversations (migration 0040); este cron TS consome via admin client.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed). Audit agregada por tick.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { logger } from "@/lib/logger";
import { runRoutingWorker } from "@/lib/routing/worker";

export const dynamic = "force-dynamic";

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO, na ordem do arquivo (cerca:
 * `tests/unit/cron-passa-pelo-portao.test.ts`). O worker só tem o que fazer
 * quando há evento `conversation.routing_requested` pendente ou em processamento;
 * a auditoria abaixo já era condicional ao tick ter drenado algo.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "let summary",
  "try",
  "if (summary.batch_size > 0 || summary.errors.length > 0)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // O PISO OCIOSO: sem evento de roteamento `pending`/`processing`, o worker faria
  // duas consultas ao `event_log` por minuto só para receber lista vazia (a
  // recuperação do travado e os pendentes). O sinal vem do pool `pg`
  // (lib/cron/piso-ocioso.ts) e, na dúvida, a rota roda.
  if (await recursoOcioso("roteamento")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  let summary;
  try {
    summary = await runRoutingWorker();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[routing-worker.cron] runRoutingWorker threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  // Tick que não drenou evento nenhum não é mutação e não ocupa linha de
  // auditoria (mesmo critério do snooze-watcher, do followup-flow-worker e do
  // recover-stuck-messages). Esta rota roda 1×/min: auditar incondicionalmente
  // gravava 43.200 linhas/mês numa instalação que não atende ninguém, numa
  // tabela append-only com retenção de anos — 95% do audit log de uma VPS real
  // era batida de cron vazia (`docs/testing/user-journey-map.md`, achado 17).
  //
  // `errors` entra na condição e NÃO é redundante com `batch_size`: quando o
  // `select` do event_log falha, `runRoutingWorker` devolve `batch_size = 0` com
  // o erro dentro (worker.ts:88). Sem esta cláusula, o tick em que o banco não
  // respondeu ficaria idêntico, na trilha, ao tick de uma instalação sem nada a
  // fazer — o mesmo defeito que `claim_falhou` conserta no followup-flow-worker.
  if (summary.batch_size > 0 || summary.errors.length > 0) {
    void audit({
      action: "routing.worker_run",
      organizationId: null,
      bypassedRls: true,
      metadata: {
        batch_size: summary.batch_size,
        outcomes: summary.outcomes,
        errors: summary.errors.length,
      },
      requestId,
    });
  }

  return ok(
    { batch_size: summary.batch_size, outcomes: summary.outcomes, errors: summary.errors },
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
