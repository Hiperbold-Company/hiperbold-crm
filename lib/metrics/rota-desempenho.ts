/**
 * A porta comum das rotas de Desempenho (`/api/v1/metrics/negocios`, `/origens`,
 * `/atendimento`, `/negocios/lista`): papel, filtro e janela, numa função só para
 * que as quatro digam a mesma coisa ao mesmo pedido.
 *
 * Piso `agent`, como `GET /metrics/attendants`: o atendente vê os PRÓPRIOS
 * números porque a leitura usa o client da sessão e a RLS escopa; gerente e
 * admin veem a organização. A organização é a ativa da sessão (cookie
 * validado), nunca da query. Leitura: sem audit.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";

import { fail } from "@/lib/api/wrappers";
import type { ApiError } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";

import { filtroDaQuery, resolverJanela } from "./desempenho";

export type PedidoDeDesempenho =
  | { ok: false; response: NextResponse<ApiError> }
  | {
      ok: true;
      requestId: string;
      orgId: string;
      from: Date;
      to: Date;
      pipelineId: string | null;
      ownerUserId: string | null;
      url: URL;
      t: (texto: string) => string;
    };

export async function abrirPedidoDeDesempenho(req: NextRequest): Promise<PedidoDeDesempenho> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const url = new URL(req.url);
  const parsed = filtroDaQuery.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    pipeline_id: url.searchParams.get("pipeline_id") ?? undefined,
    owner_user_id: url.searchParams.get("owner_user_id") ?? undefined,
  });
  if (!parsed.success) {
    return {
      ok: false,
      response: fail("validation_failed", t("Query inválida."), 422, {
        details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
        requestId,
      }),
    };
  }
  const janela = resolverJanela(parsed.data);
  if (!janela.ok) {
    const mensagem =
      janela.motivo === "ordem"
        ? t("Janela inválida: 'from' deve ser anterior a 'to'.")
        : t("Período longo demais: escolha até 366 dias.");
    return { ok: false, response: fail("validation_failed", mensagem, 422, { requestId }) };
  }

  return {
    ok: true,
    requestId,
    orgId: authz.org.orgId,
    from: janela.from,
    to: janela.to,
    pipelineId: parsed.data.pipeline_id ?? null,
    ownerUserId: parsed.data.owner_user_id ?? null,
    url,
    t,
  };
}
