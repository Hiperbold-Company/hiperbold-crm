/**
 * GET /api/v1/custom-fields/[id]/stats — registros preenchidos, total, taxa, vazios, último uso
 * (`updated_at` do registro), tamanho médio do valor, criado em e última edição. Gerente+, só sessão.
 */
import { randomUUID } from "node:crypto";
import { campoEhRestrito, leitorVeCamposRestritos } from "@/lib/campos/recorte-por-papel";
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { estatisticasDaDefinicao } from "@/lib/campos/administracao";

import { UUID_RX, entradaDosCampos } from "../../_entrada";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const e = await entradaDosCampos(requestId);
  if (!e.ok) return e.response;
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", e.t("id inválido."), 400, { requestId });
  try {
    const { definicao, estatisticas } = await estatisticasDaDefinicao(e.deps, id);
    // 1015: a definição não pública (e o retrato dos valores dela) só vai para administrador.
    if (campoEhRestrito(definicao) && !leitorVeCamposRestritos(e.deps.papel)) {
      return fail("not_found", e.t("Campo não encontrado."), 404, { requestId });
    }
    return ok(estatisticas, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
