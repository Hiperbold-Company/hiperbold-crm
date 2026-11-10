import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Uma CHAVE SECRETA das automações, gerente+.
 *
 *   PATCH  — troca o valor `{ valor }` (o nome não muda: é por ele que a tela a lista).
 *   DELETE — apaga. Chave usada por automação PUBLICADA é recusada (409) com o
 *            nome das automações: apagar faria o bloco "Requisição HTTP" sair por
 *            "Falhou" em toda execução, em silêncio.
 *
 * O valor nunca volta na resposta nem no audit.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  apagarSegredo,
  automacoesQueUsam,
  lerSegredoVisivel,
  trocarValorDoSegredo,
  valorDoSegredoSchema,
} from "@/lib/automacoes/segredos";
import { createAdminClient } from "@/lib/supabase/admin";

import { portaDoCofre, UUID_RX } from "../_porta";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const patchSchema = z.strictObject({ valor: valorDoSegredoSchema });

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const p = await portaDoCofre(req, true);
  if (p.resposta) return p.resposta;
  const { org, requestId, t } = p;
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", t("id inválido."), 400, { requestId });

  const corpo = patchSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", t("Cole a chave inteira, sem espaços (mínimo de 8 caracteres)."), 400, { requestId });
  }
  const r = await trocarValorDoSegredo(createAdminClient(), { org, id, valor: corpo.data.valor });
  if (!r.ok) {
    if (r.erro === "nao_encontrado") return fail("not_found", t("Chave não encontrada."), 404, { requestId });
    return fail(
      "internal_error",
      r.erro === "cifra_indisponivel"
        ? t("A cifra do servidor não está disponível; a chave não foi gravada.")
        : t("Não consegui gravar a chave."),
      500,
      { requestId },
    );
  }
  await audit({
    action: "automacao.chave_trocada",
    actorUserId: p.atorId,
    organizationId: org,
    resourceType: "automacao_segredos",
    resourceId: id,
    requestId,
    metadata: { nome: r.segredo.nome, ultimos4: r.segredo.ultimos4 },
  });
  return ok(r.segredo, { requestId });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const p = await portaDoCofre(req, true);
  if (p.resposta) return p.resposta;
  const { org, requestId, t } = p;
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", t("id inválido."), 400, { requestId });

  const admin = createAdminClient();
  try {
    const atual = await lerSegredoVisivel(admin, org, id);
    if (!atual) return fail("not_found", t("Chave não encontrada."), 404, { requestId });
    const usam = await automacoesQueUsam(admin, org, id);
    if (usam.length > 0) {
      return fail(
        "segredo_em_uso",
        `${t("Esta chave é usada por automação publicada. Troque a chave nestas automações (ou desative-as) antes de apagar:")} ${usam.join(", ")}`,
        409,
        { requestId, details: { automacoes: usam } },
      );
    }
    const removeu = await apagarSegredo(admin, org, id);
    if (removeu) {
      await audit({
        action: "automacao.chave_apagada",
        actorUserId: p.atorId,
        organizationId: org,
        resourceType: "automacao_segredos",
        resourceId: id,
        requestId,
        metadata: { nome: atual.nome },
      });
    }
    return ok({ id, removida: removeu }, { requestId });
  } catch {
    return fail("internal_error", t("Não consegui apagar a chave."), 500, { requestId });
  }
}
