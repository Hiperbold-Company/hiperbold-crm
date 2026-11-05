import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/pipelines/[id]/duplicate — copia o funil com etapas e configuração (manager+).
 *
 * Corpo: `{ name }`, o nome do funil novo. A organização sai da sessão (ou da linha do token `dsk_…`),
 * nunca do corpo nem da URL; funil de outra organização responde 404 e funil arquivado, 409.
 * `Idempotency-Key` opcional (recibo em `idempotency_keys`): o duplo clique não cria dois funis.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra (o que é copiado, a troca dos ids de etapa no settings, a compensação)
 * vive em `lib/pipelines/duplicar.ts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { chaveDaRequisicao, comIdempotencia, identidadeDoAtor } from "@/lib/api/idempotency";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { duplicarFunil, type FunilDuplicado } from "@/lib/pipelines/duplicar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// O mesmo teto do POST de funil: o nome é o título de uma linha da lista e o topo do quadro.
const bodySchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_pipelines",
    role: "manager",
    escrita: true,
    permissao: "funis.editar",
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  const { id: origemId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", t("Dê um nome ao novo funil (até 80 caracteres)."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", t("Idempotency-Key deve ser um UUID."), 400, { requestId });
  }

  const deps = {
    supabase: authz.supabase,
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
    t,
  };
  const executar = async () => ({ resposta: await duplicarFunil(deps, origemId, parsed.data), status: 201 });

  try {
    if (chave === null) {
      const r = await executar();
      return ok(r.resposta, { status: 201, requestId });
    }
    const desfecho = await comIdempotencia<FunilDuplicado>({
      // Servidor, não a sessão: `idempotency_keys` não é legível nem gravável por `authenticated`.
      db: createAdminClient(),
      organizationId: authz.organizationId,
      endpoint: `/api/v1/pipelines/${origemId}/duplicate`,
      chave,
      ator: identidadeDoAtor(authz.actor),
      corpo: parsed.data,
      executar,
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, {
        requestId,
      });
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );
    }
    return ok(desfecho.resposta, { status: 201, requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
