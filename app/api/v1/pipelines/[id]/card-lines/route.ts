import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/pipelines/[id]/card-lines — as linhas do cartão deste funil
 * ("Editar cartão" no quadro). Iguais para toda a equipe.
 *
 * Corpo: `{ card_lines: CampoDoCartao[] }` (até 5, sem repetir, do vocabulário
 * fechado de `lib/kanban/linhas-do-cartao.ts`) ou `{ card_lines: null }`, que é
 * o "Voltar ao padrão": APAGA a chave, e o funil volta a "nunca configurado".
 *
 * Por que rota própria e não `PATCH …/config`: aquela exige `admin` (a
 * configuração do funil), e esta é decisão de gerente; e ela não sabe apagar
 * chave.
 *
 * Auth: só sessão, `manager`+ conferido no banco (`requireRole`). A organização
 * vem da sessão; funil de outra organização responde 404, igual ao inexistente.
 * Merge em `settings`: só `card_lines` muda. LER-MODIFICAR-GRAVAR com trava
 * otimista por `updated_at` (mesma técnica de `aplicarConfiguracaoDoFunil`):
 * há outro escritor de `settings`, e o último a gravar não pode apagar a chave
 * do primeiro.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok, falhaInterna } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { linhasDoCartao, patchDasLinhasSchema, settingsComLinhas } from "@/lib/kanban/linhas-do-cartao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const TENTATIVAS = 4;

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = patchDasLinhasSchema.safeParse(json);
  if (!parsed.success) {
    return fail("invalid_request", t("Escolha até 5 linhas, sem repetir campo."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const linhas = parsed.data.card_lines;

  const supabase = await createClient();
  let gravou = false;
  for (let tentativa = 0; tentativa < TENTATIVAS && !gravou; tentativa += 1) {
    const { data: row, error: readErr } = await supabase
      .from("crm_pipelines")
      .select("id, settings, updated_at")
      .eq("id", pipelineId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (readErr) return falhaInterna("internal_error", readErr, { requestId });
    if (!row) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

    const atual = (row as { settings: Record<string, unknown> | null }).settings;
    let escrita = supabase
      .from("crm_pipelines")
      .update({ settings: settingsComLinhas(atual, linhas) })
      .eq("id", pipelineId)
      .eq("organization_id", orgId);
    const versaoLida = (row as { updated_at?: string | null }).updated_at;
    if (versaoLida) escrita = escrita.eq("updated_at", versaoLida);
    const { data: gravadas, error } = await escrita.select("id");
    if (error) return falhaInterna("internal_error", error, { requestId });
    gravou = (gravadas ?? []).length > 0;
  }
  if (!gravou) {
    return fail("conflict", t("Outra pessoa alterou este funil ao mesmo tempo. Recarregue e tente de novo."), 409, {
      requestId,
    });
  }

  void audit({
    action: "pipeline.card_lines_updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "pipeline",
    resourceId: pipelineId,
    requestId,
    // Só os NOMES dos campos: nenhum valor de contato entra no audit.
    metadata: { card_lines: linhas, voltou_ao_padrao: linhas === null },
  });

  const efetivas = linhas ?? linhasDoCartao(undefined);
  return ok({ card_lines: efetivas, padrao: linhas === null }, { requestId });
}
