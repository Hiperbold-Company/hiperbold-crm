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
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO, na ordem do arquivo (a cerca é
 * `tests/unit/cron-passa-pelo-portao.test.ts`, que lê o AST desta rota). Tudo
 * abaixo do `if (await recursoOcioso(...))` só roda quando há linha vencida na
 * fila (ou `enviando` parada, que `destravar` resolve): é o que se quer. A
 * auditoria só acontece quando houve efeito, então sair cedo não a tira.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const resumo",
  "if (resumo.enviadas + resumo.expiradas + resumo.falharam + resumo.destravadas > 0)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function executar(req: NextRequest): Promise<Response> {
  if (!autorizaCron(req)) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  }
  // O PISO OCIOSO: sem resposta vencida na fila nem envio parado, a rodada (um
  // update de destravar + um select, a cada minuto) só traria lista vazia. O
  // sinal é lido pelo pool `pg` (lib/cron/piso-ocioso.ts) e, na dúvida, a rota roda.
  if (await recursoOcioso("fila_meta_social")) return NextResponse.json({ data: { pulado: "recurso_ocioso" } });
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
