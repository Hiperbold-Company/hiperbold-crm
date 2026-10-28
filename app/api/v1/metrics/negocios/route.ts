/**
 * GET /api/v1/metrics/negocios — Desempenho, aba Negócios (cartões, série diária, etapas, movimentações, ranking).
 *
 * A conta é `fn_desempenho_negocios` (migration 0981), SECURITY INVOKER chamada com o client
 * da sessão: a RLS escopa o atendente ao que ele já vê. Filtro e papel em
 * `lib/metrics/rota-desempenho.ts`. O nome de cada pessoa do ranking vem de
 * `lib/metrics/nomes.ts` (só `full_name`). Read-only ⇒ sem audit.
 */
import { type NextRequest } from "next/server";

import { falhaInterna, ok } from "@/lib/api/wrappers";
import { comNomes } from "@/lib/metrics/nomes";
import { abrirPedidoDeDesempenho } from "@/lib/metrics/rota-desempenho";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const pedido = await abrirPedidoDeDesempenho(req);
  if (!pedido.ok) return pedido.response;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_desempenho_negocios", {
    p_org: pedido.orgId,
    p_from: pedido.from.toISOString(),
    p_to: pedido.to.toISOString(),
    p_pipeline: pedido.pipelineId ?? undefined,
    p_owner: pedido.ownerUserId ?? undefined,
  });
  if (error) return falhaInterna("internal_error", error, { requestId: pedido.requestId });

  const corpo = (data ?? {}) as { atendentes?: Array<{ user_id: string | null }> } & Record<string, unknown>;
  const atendentes = await comNomes(corpo.atendentes ?? []);

  return ok(
    {
      janela: { from: pedido.from.toISOString(), to: pedido.to.toISOString() },
      ...corpo,
      atendentes,
    },
    { requestId: pedido.requestId },
  );
}
