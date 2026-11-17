import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/custom-fields?entidade=contato|negocio — os campos personalizados da organização.
 * POST /api/v1/custom-fields — cria um campo (contato ou negócio). Chave repetida = 409; cota por
 *      entidade = 422.
 *
 * Regra em `lib/campos/administracao.ts`; porta em `./_entrada.ts` (gerente+, só sessão).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { criarDefinicao, listarDefinicoes } from "@/lib/campos/administracao";
import { ENTIDADES_DE_CAMPO, novaDefinicaoSchema } from "@/lib/campos/definicoes";

import { entradaDosCampos } from "./_entrada";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const e = await entradaDosCampos(requestId);
  if (!e.ok) return e.response;
  const entidade = req.nextUrl.searchParams.get("entidade");
  if (entidade !== null && !(ENTIDADES_DE_CAMPO as readonly string[]).includes(entidade)) {
    return fail("invalid_request", e.t("entidade deve ser contato ou negocio."), 400, { requestId });
  }
  try {
    const lista = await listarDefinicoes(e.deps, (entidade ?? undefined) as "contato" | "negocio" | undefined);
    return ok(lista, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const e = await entradaDosCampos(requestId);
  if (!e.ok) return e.response;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", e.t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = novaDefinicaoSchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", e.t("Não entendi o campo. Informe entidade, key, label e type."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await criarDefinicao(e.deps, parsed.data), { requestId, status: 201 });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
