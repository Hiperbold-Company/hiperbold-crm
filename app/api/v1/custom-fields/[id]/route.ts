import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/custom-fields/[id] — altera um campo. `key`, `type` e `entidade` não mudam (corpo
 *        `strict`: mandá-los é 422; o banco também recusa). `config` faz merge por chave.
 * DELETE /api/v1/custom-fields/[id] — tira a DEFINIÇÃO. Os valores ficam nos registros; a resposta
 *        traz `registros_com_valor` (o mesmo número que a tela mostra antes de confirmar).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { alterarDefinicao, removerDefinicao } from "@/lib/campos/administracao";
import { alteracaoDeDefinicaoSchema } from "@/lib/campos/definicoes";

import { UUID_RX, entradaDosCampos } from "../_entrada";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const e = await entradaDosCampos(requestId, { escrita: true });
  if (!e.ok) return e.response;
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", e.t("id inválido."), 400, { requestId });
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", e.t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = alteracaoDeDefinicaoSchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", e.t("Não entendi o que mudar no campo."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await alterarDefinicao(e.deps, id, parsed.data), { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const e = await entradaDosCampos(requestId, { escrita: true });
  if (!e.ok) return e.response;
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", e.t("id inválido."), 400, { requestId });
  try {
    return ok(await removerDefinicao(e.deps, id), { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
