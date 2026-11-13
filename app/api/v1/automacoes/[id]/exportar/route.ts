/**
 * GET /api/v1/automacoes/:id/exportar — a automação como arquivo
 * `hiperbold-automacao` v1 (`lib/automacoes/portabilidade.ts`): o rascunho (ou a
 * versão no ar, sem rascunho), com cada id da organização trocado por uma
 * referência legível. Nunca leva valor de chave secreta nem e-mail.
 *
 * Auth: sessão OU token `dsk_…`, `manager` (o mesmo papel do editor). É leitura —
 * não audita, como o exportar dos follow-ups.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import {
  ErroDeExportacao,
  exportarAutomacao,
  nomeDoArquivoDaAutomacao,
} from "@/lib/automacoes/portabilidade";
import { catalogoDaConta } from "@/lib/automacoes/portabilidade-db";
import { logger } from "@/lib/logger";
import { entradaDeFluxo } from "@/lib/followup/porta";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const e = await entradaDeFluxo(req, { escrita: false, role: "manager", id });
  if (e.resposta) return e.resposta;
  const { deps, requestId } = e;
  const t = deps.t ?? ((x: string) => x);

  const { data: ponteiro, error } = await deps.admin
    .from("followup_flow_pointers")
    .select("id, name, draft_graph, active_version_id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .eq("surface", "automacao")
    .maybeSingle();
  if (error) {
    logger.error("automacao_exportar_leitura_falhou", { requestId, err: error.message });
    return fail("internal_error", t("Não consegui exportar a automação. Tente de novo."), 500, { requestId });
  }
  if (!ponteiro) return fail("not_found", t("Esta automação não existe mais, ou não é desta organização."), 404, { requestId });

  const grafo = await rascunhoDoFluxo(
    deps.admin,
    ponteiro as { draft_graph: unknown; active_version_id: string | null },
    deps.organizationId,
  );
  if (!grafo) return fail("not_found", t("Esta automação ainda não tem caixas para exportar."), 404, { requestId });

  try {
    const catalogo = await catalogoDaConta(deps.admin, deps.organizationId);
    const arquivo = exportarAutomacao({ id, nome: String(ponteiro.name), grafo }, catalogo, new Date());
    return ok({ file_name: nomeDoArquivoDaAutomacao(String(ponteiro.name)), file: arquivo }, { requestId });
  } catch (err) {
    if (err instanceof ErroDeExportacao) {
      return fail(
        "automacao_com_id_desconhecido",
        t("A automação cita algo que não existe mais nesta conta. Abra o editor, escolha de novo o item que falta e exporte outra vez."),
        422,
        { requestId, details: { caminho: err.caminho } },
      );
    }
    logger.error("automacao_exportar_falhou", { requestId, err: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", t("Não consegui exportar a automação. Tente de novo."), 500, { requestId });
  }
}
