/**
 * A TAREFA VENCEU — a varredura (migration 0980).
 *
 * O prazo de uma tarefa passa sem acontecimento nenhum: ninguém clica em nada
 * às 10h de 03/11. Quem percebe é o relógio, e este cron existe para
 * transformar o vencimento em `crm_task.due` no `event_log`. O que fazer com
 * ele é do consumidor do barramento (`lib/notifications/push.handler.ts`), que
 * manda o push ao celular de quem criou a tarefa e do responsável.
 *
 * Tudo o que decide mora na função do banco, `fn_reivindicar_tarefas_vencidas`:
 * qual tarefa (aberta, vencida nas últimas 24h, ainda não avisada NESTE
 * vencimento), a marca que impede o segundo aviso, e o evento — na mesma
 * transação, com `skip locked` contra rodadas sobrepostas. A rota só chama, e
 * a organização de cada evento sai da linha da tarefa, nunca daqui.
 *
 * De minuto em minuto porque o aviso é "na hora": "ligar às 10h" avisado às
 * 10h14 já é atraso. Rodada sem vencimento é uma consulta num índice parcial.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto por rodada. O que sobrar fica para o minuto seguinte. */
export const LIMITE_POR_RODADA = 200;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_reivindicar_tarefas_vencidas" as never, {
    p_limite: LIMITE_POR_RODADA,
  } as never);

  if (error) {
    logger.error("[tarefas-vencidas] reivindicação falhou", {
      error: (error as { message?: string }).message,
      requestId,
    });
    return fail("internal_error", "Falha ao varrer as tarefas vencidas.", 500, { requestId });
  }

  const linhas = (data ?? []) as Array<{ task_id: string; organization_id: string }>;
  const avisadas = linhas.length;

  // Rodada que não avisou nada NÃO é mutação, e não audita (CLAUDE.md §Audit
  // log; `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).
  if (avisadas > 0) {
    await audit({
      action: "crm_task.due_notified",
      resourceType: "crm_tasks",
      metadata: {
        avisadas,
        organizacoes: new Set(linhas.map((l) => l.organization_id)).size,
      },
      requestId,
    });
  }

  return ok({ avisadas }, { requestId });
}

export const GET = handle;
export const POST = handle;
