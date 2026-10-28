/**
 * GET /api/v1/metrics/origens — Desempenho, aba Origens (utm_source, utm_medium e utm_campaign dos negócios criados).
 *
 * A conta é `fn_desempenho_origens` (migration 0981), SECURITY INVOKER chamada com o client
 * da sessão: a RLS escopa o atendente aos negócios que ele já vê. Filtro e papel
 * em `lib/metrics/rota-desempenho.ts`. Read-only ⇒ sem audit.
 */
import { type NextRequest } from "next/server";

import { falhaInterna, ok } from "@/lib/api/wrappers";
import { abrirPedidoDeDesempenho } from "@/lib/metrics/rota-desempenho";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const pedido = await abrirPedidoDeDesempenho(req);
  if (!pedido.ok) return pedido.response;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_desempenho_origens", {
    p_org: pedido.orgId,
    p_from: pedido.from.toISOString(),
    p_to: pedido.to.toISOString(),
    p_pipeline: pedido.pipelineId ?? undefined,
    p_owner: pedido.ownerUserId ?? undefined,
  });
  if (error) return falhaInterna("internal_error", error, { requestId: pedido.requestId });

  return ok(
    {
      janela: { from: pedido.from.toISOString(), to: pedido.to.toISOString() },
      ...((data ?? {}) as Record<string, unknown>),
    },
    { requestId: pedido.requestId },
  );
}
