/**
 * Cron diário: renova os tokens longos do Instagram do canal social oficial
 * (60 dias) antes de vencerem. Regra e janela em
 * `lib/channels/meta-social/renovacao.ts`. Falha marca a sessão e o vigia
 * `channel-health` abre o aviso na Central.
 *
 * Audita SÓ quando houve efeito (renovou ou falhou): rodada vazia não é
 * mutação (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { renovarTokensDoInstagram } from "@/lib/channels/meta-social/renovacao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function executar(req: NextRequest): Promise<Response> {
  if (!autorizaCron(req)) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  }
  const resumo = await renovarTokensDoInstagram(createAdminClient(), new Date());
  if (resumo.renovadas > 0 || resumo.falhas > 0) {
    await audit({
      action: "channel.meta_social_tokens_renewed",
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
