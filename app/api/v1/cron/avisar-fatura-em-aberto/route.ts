/**
 * GET/POST /api/v1/cron/avisar-fatura-em-aberto: a régua de cobrança do pedido de assinatura não pago (COB-05 com o
 * link da fatura; migration 1026).
 *
 * Irmã de `avisar-renovacao-no-cartao` (COB-04), mas com GET no Asaas: antes de enfileirar cada marco ela confere a
 * cobrança (paga ou removida não recebe aviso) e pega o link atual da fatura. A regra (quem entra, os marcos, a
 * chave de idempotência) está em `lib/email/conta-e-cobranca/regua-de-cobranca.ts` e no banco
 * (`fn_billing_regua_de_cobranca_pendentes`); este arquivo só autentica, monta o cliente do Asaas e registra o
 * resumo no log.
 *
 * Sem `ASAAS_ENABLED`, a rodada não toca banco nem rede e devolve contagem zero (mesma doutrina de
 * `conciliar-asaas`). `configDoAsaas()` pode LANÇAR (configuração incoerente): a resposta HTTP traz frase fixa; o
 * texto do erro fica só no log.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET, fail-closed,
 * `lib/auth/cron-auth.ts`).
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh), uma vez por dia às
 * 11:10 UTC (08:10 em América/São_Paulo), logo depois do aviso de renovação no cartão. A imagem
 * `deskcomm-scheduler` precisa ser publicada de novo para o agendamento valer em produção.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { criarClienteAsaas } from "@/lib/billing/asaas/cliente";
import { configDoAsaas } from "@/lib/billing/asaas/config";
import { avisarFaturasEmAberto, type ResumoDaRegua } from "@/lib/email/conta-e-cobranca/regua-de-cobranca";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RESUMO_DESLIGADO: ResumoDaRegua = {
  avaliados: 0,
  enfileirados: 0,
  jaAvisados: 0,
  pagos: 0,
  pagamentosRegistrados: 0,
  semFatura: 0,
  foraDoMarco: 0,
  vencimentosGravados: 0,
  orgParada: 0,
  outroAmbiente: 0,
  falhas: 0,
  restantes: 0,
};

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resumo: ResumoDaRegua;
  try {
    const config = configDoAsaas();
    if (!config.habilitado) {
      return ok({ ...RESUMO_DESLIGADO, habilitado: false }, { requestId });
    }
    const asaas = criarClienteAsaas({ fetch, config, logger });
    resumo = await avisarFaturasEmAberto(createAdminClient(), { asaas, ambiente: config.ambiente });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[regua-de-cobranca] falhou", { error: detalhe, requestId });
    return fail("internal_error", "Falha ao avisar as faturas em aberto.", 500, { requestId });
  }

  if (resumo.falhas > 0 || resumo.restantes > 0) {
    logger.warn("[regua-de-cobranca] rodada com pendência", { ...resumo, requestId });
  } else {
    logger.info("[regua-de-cobranca] rodada concluída", { ...resumo, requestId });
  }

  return ok({ ...resumo, habilitado: true }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
