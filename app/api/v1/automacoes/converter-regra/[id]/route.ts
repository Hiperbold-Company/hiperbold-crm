import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Converter uma regra antiga (`automation_rules`) em automação — lote 5, "tela única".
 *
 * GET  — a pré-visualização: o grafo que a conversão montaria, ou a lista do que não tem
 *        equivalente. Não grava nada.
 * POST — publica: cria a automação, desliga a regra e marca o vínculo numa transação só
 *        (`fn_automacao_converter_regra`, migration 1005). Aceita `Idempotency-Key`; sem a
 *        chave, o reenvio também não duplica (a regra já convertida devolve o vínculo).
 *
 * Auth: sessão OU token `dsk_…` (`manager`, como as telas de regras e de automações). A
 * organização sai da sessão/da linha do token, nunca do corpo.
 */
import type { NextRequest } from "next/server";

import { comIdempotencia, chaveDaRequisicao, identidadeDoAtor } from "@/lib/api/idempotency";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { converterEPublicarRegra, lerRegra, previaDaConversao } from "@/lib/automacoes/conversao";
import { entradaDeFluxo } from "@/lib/followup/porta";

export const dynamic = "force-dynamic";

const ENDPOINT = "POST /api/v1/automacoes/converter-regra/[id]";
type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const e = await entradaDeFluxo(req, { escrita: false, role: "manager", id });
  if (e.resposta) return e.resposta;
  try {
    const regra = await lerRegra(e.deps, id);
    const previa = previaDaConversao(regra);
    return ok(
      {
        rule: {
          id: regra.id,
          name: regra.name,
          is_active: regra.is_active,
          migrated_to_pointer_id: regra.migrated_to_pointer_id,
        },
        conversivel: previa.conversivel,
        grafo: previa.grafo,
        nao_convertido: previa.naoConvertido,
      },
      { requestId: e.requestId },
    );
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;
  const e = await entradaDeFluxo(req, { escrita: true, role: "manager", id });
  if (e.resposta) return e.resposta;
  const t = e.deps.t ?? ((x: string) => x);

  try {
    const chave = chaveDaRequisicao(req);
    if (chave === null) {
      const feito = await converterEPublicarRegra(e.deps, id);
      return ok(feito, { requestId: e.requestId, status: feito.ja_convertida ? 200 : 201 });
    }
    const desfecho = await comIdempotencia({
      db: e.deps.admin,
      organizationId: e.deps.organizationId,
      endpoint: ENDPOINT,
      chave,
      ator: identidadeDoAtor(e.deps.actor),
      corpo: { rule_id: id },
      executar: async () => {
        const feito = await converterEPublicarRegra(e.deps, id);
        return { resposta: feito, status: feito.ja_convertida ? 200 : 201 };
      },
    });
    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        {
          requestId: e.requestId,
        },
      );
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma conversão ainda está em curso. Tente de novo em instantes."),
        409,
        {
          requestId: e.requestId,
        },
      );
    }
    return ok(desfecho.resposta, { requestId: e.requestId, status: desfecho.status as 200 | 201 });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
