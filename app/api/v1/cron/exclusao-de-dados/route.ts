/**
 * GET/POST /api/v1/cron/exclusao-de-dados: a rodada diária da exclusão dos dados depois do cancelamento
 * (migration 0959, D-209). A Política de Privacidade promete 90 dias de guarda depois do fim da assinatura de
 * quem pagou; esta rota programa, avisa (D-30 e D-7, COB-12) e exclui as organizações vencidas. A ordem, a
 * regra de quem entra e a guarda que protege o resto moram em `lib/retencao/exclusao-de-organizacao/rodada.ts`
 * e em `fn_exclusao_executar` (banco); este arquivo só autentica, chama e responde.
 *
 * Auditoria: SÓ quando houve efeito. Rodada vazia (a quase totalidade dos dias) não escreve nada. Cada
 * exclusão já grava a própria linha `org.data_purged` dentro do banco, na mesma transação; aqui ficam as linhas
 * das programações novas e das canceladas por reativação.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET (`lib/auth/cron-auth.ts`), fail-closed. O texto de erro do
 * banco só vai para o log. Agendamento: `docker/scheduler/entrypoint.sh`, 06:00 UTC (03:00 em São Paulo), depois
 * das rodadas de billing que movem o contrato (05:40) e do envio de e-mails (minuto a minuto).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { logger } from "@/lib/logger";
import { interpretarDiasDeGuarda } from "@/lib/retencao/exclusao-de-organizacao/datas";
import { rodarExclusaoDeDados, type ResumoDaRodada } from "@/lib/retencao/exclusao-de-organizacao/rodada";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoDaRodada;
  try {
    const dias = interpretarDiasDeGuarda((await valorDaInstalacao("DIAS_DE_GUARDA_APOS_CANCELAMENTO")).valor);
    if (!dias.ok) {
      // Configuração preenchida com lixo: a rodada INTEIRA não roda (nada é programado, avisado nem excluído).
      logger.error("[exclusao-de-dados] DIAS_DE_GUARDA_APOS_CANCELAMENTO inválido; rodada abortada", { requestId });
      return fail("config_invalida", "Configuração de dias de guarda inválida; a rodada não rodou.", 500, { requestId });
    }
    resumo = await rodarExclusaoDeDados(createAdminClient(), { diasDeGuarda: dias.dias });
  } catch (err) {
    logger.error("[exclusao-de-dados] falhou", { error: err instanceof Error ? err.message : String(err), requestId });
    return fail("internal_error", "Falha na rodada de exclusão dos dados.", 500, { requestId });
  }

  if (resumo.programadas > 0) {
    void audit({
      action: "org.deletion_scheduled",
      resourceType: "organization",
      metadata: { origem: "automatica", organizacoes: resumo.programadas, requestId },
      requestId,
    });
  }
  if (resumo.canceladasPorReativacao > 0) {
    void audit({
      action: "org.deletion_cancelled",
      resourceType: "organization",
      metadata: { origem: "reativacao", organizacoes: resumo.canceladasPorReativacao, requestId },
      requestId,
    });
  }

  if (resumo.sincronizacaoFalhou || resumo.falhas > 0) {
    logger.warn("[exclusao-de-dados] rodada com pendência", { ...resumo, requestId });
  } else if (resumo.excluidas > 0 || resumo.programadas > 0 || resumo.avisosEnfileirados > 0) {
    logger.info("[exclusao-de-dados] rodada concluída", { ...resumo, requestId });
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
