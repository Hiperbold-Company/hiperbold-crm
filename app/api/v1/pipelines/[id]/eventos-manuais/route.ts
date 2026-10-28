/**
 * GET /api/v1/pipelines/[id]/eventos-manuais
 *
 * Quantos eventos registrados à mão ("Registrar evento" da ficha) cada negócio do
 * funil tem — o dado do filtro "Eventos manuais" do quadro. A contagem é do banco
 * (`fn_contar_eventos_manuais_do_funil`, migration 0979): o navegador recebe um
 * número por negócio, nunca a timeline.
 *
 * Resposta: `{ data: { contagens: { [lead_id]: total } } }`. Negócio ausente do
 * mapa tem zero eventos manuais.
 *
 * Auth: `requireRole("viewer")`, o mesmo piso do quadro (`/board`): é leitura do
 * que o quadro já mostra. O cliente é o DA SESSÃO — com `visibility_mode = own`
 * a RLS devolve só os negócios do atendente, e a contagem segue a mesma visão.
 * `organization_id` sai da sessão, nunca da URL.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, falhaInterna, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const idDoFunil = z.string().uuid();

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  const parsed = idDoFunil.safeParse(id);
  if (!parsed.success) {
    return fail("validation_error", t("Funil inválido."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_contar_eventos_manuais_do_funil", {
    p_organization_id: authz.org.orgId,
    p_pipeline_id: parsed.data,
  });
  if (error) return falhaInterna("internal_error", error, { requestId });

  const contagens: Record<string, number> = {};
  for (const linha of (data ?? []) as Array<{ lead_id: string; total: number }>) {
    contagens[linha.lead_id] = Number(linha.total) || 0;
  }
  return ok({ contagens }, { requestId });
}
