/**
 * Cron de minuto em minuto: envia as respostas a comentários do Instagram que
 * as automações puseram na fila (migration 0991), no ritmo de cada conta.
 * Regras (teto por hora, privada antes da pública, 7 dias, limite da Meta) em
 * `lib/channels/meta-social/fila.ts`.
 *
 * Audita SÓ quando houve efeito (enviou, expirou, falhou ou destravou): rodada
 * vazia não é mutação (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { processarFilaMetaSocial } from "@/lib/channels/meta-social/fila";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function executar(req: NextRequest): Promise<Response> {
  if (!autorizaCron(req)) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  }
  const resumo = await processarFilaMetaSocial(createAdminClient(), new Date());
  if (resumo.enviadas + resumo.expiradas + resumo.falharam + resumo.destravadas > 0) {
    await audit({
      action: "channel.meta_social_fila_processada",
      metadata: { ...resumo },
    });
  }
  return NextResponse.json({ data: resumo });
}

export async function GET(req: NextRequest): Promise<Response> {
  return executar(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return executar(req);
}
