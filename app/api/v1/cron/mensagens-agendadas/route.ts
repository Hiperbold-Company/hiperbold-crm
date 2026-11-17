/**
 * GET/POST /api/v1/cron/mensagens-agendadas — envia as mensagens agendadas no
 * chat cuja hora chegou (migration 1017).
 *
 * A regra inteira mora em `lib/mensagens-agendadas/worker.ts`; esta rota é só a
 * borda: autoriza, roda, e audita quando houve efeito.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler`
 * (`docker/scheduler/entrypoint.sh`), a cada minuto.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { houveEfeito, rodarMensagensAgendadas, type ResultadoDaRodada } from "@/lib/mensagens-agendadas/worker";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: ResultadoDaRodada;
  try {
    result = await rodarMensagensAgendadas(createAdminClient(), new Date(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[mensagens-agendadas] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to send scheduled messages.", 500, { requestId });
  }

  // Rodada que só adiou ou não achou nada não é mutação e não ocupa linha de
  // auditoria (tests/unit/cron-audita-so-quando-ha-efeito.test.ts).
  if (houveEfeito(result)) {
    void audit({
      action: "scheduled_message.run",
      organizationId: null,
      bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
