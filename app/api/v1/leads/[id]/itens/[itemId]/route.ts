/**
 * PATCH  /api/v1/leads/:id/itens/:itemId — muda a quantidade e/ou o valor unitário.
 * DELETE /api/v1/leads/:id/itens/:itemId — tira o produto do negócio.
 *
 * Os dois ids vão no PATH e o item é buscado pelos DOIS (`id` e `lead_id`) mais a
 * organização da sessão: um item de outro negócio — ou de outra organização — é
 * 404, igual ao que não existe. O valor do negócio se refaz no banco (gatilho,
 * migration 0972); a resposta devolve o `value_cents` já somado.
 *
 * Apagar o ÚLTIMO item não zera o valor do negócio: ele volta a ser digitado à
 * mão e fica com o último total.
 *
 * Papel `agent`; `requireSupportWrite` abre o handler, antes de qualquer efeito.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, falhaInterna, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { registrarAtividadeDeItem } from "@/lib/leads/itens-do-negocio";
import { ehUuid } from "@/lib/query/cursor-seguro";
import {
  COLUNAS_DO_ITEM_DO_NEGOCIO,
  itemDoNegocioPatchSchema,
  MENSAGEM_DO_TETO_DO_SUBTOTAL,
} from "@/lib/schemas/lead-itens";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; itemId: string }> };

async function valorDoNegocio(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  leadId: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("crm_leads")
    .select("value_cents")
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .maybeSingle();
  return (data as { value_cents: number | null } | null)?.value_cents ?? null;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId, itemId } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_itens" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma ?? "pt-BR");
  if (!ehUuid(leadId) || !ehUuid(itemId)) {
    return fail("not_found", t("Produto do negócio não encontrado."), 404, { requestId });
  }

  const parsed = itemDoNegocioPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data: item, error } = await supabase
    .from("crm_lead_itens")
    .update(parsed.data)
    .eq("organization_id", org.orgId)
    .eq("lead_id", leadId)
    .eq("id", itemId)
    .select(COLUNAS_DO_ITEM_DO_NEGOCIO)
    .maybeSingle();
  // 23514 = CHECK do teto do subtotal (um só campo no corpo: o Zod não vê o outro). É 422, nunca 500.
  if (error?.code === "23514") {
    return fail("validation_failed", t(MENSAGEM_DO_TETO_DO_SUBTOTAL), 422, { requestId });
  }
  if (error) return falhaInterna("internal_error", error, { requestId });
  if (!item) return fail("not_found", t("Produto do negócio não encontrado."), 404, { requestId });

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "lead.product_updated",
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId,
    metadata: { item_id: itemId, ...parsed.data },
  });

  return ok(
    { item, lead_value_cents: await valorDoNegocio(supabase, org.orgId, leadId) },
    { requestId },
  );
}

export async function DELETE(_req: NextRequest, ctx: Params): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId, itemId } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_itens" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma ?? "pt-BR");
  if (!ehUuid(leadId) || !ehUuid(itemId)) {
    return fail("not_found", t("Produto do negócio não encontrado."), 404, { requestId });
  }

  const supabase = await createClient();
  // Confere que a linha existia ANTES de auditar: um DELETE barrado pela RLS
  // devolveria sucesso e gravaria auditoria de uma mutação que não aconteceu.
  const { data: apagado, error } = await supabase
    .from("crm_lead_itens")
    .delete()
    .eq("organization_id", org.orgId)
    .eq("lead_id", leadId)
    .eq("id", itemId)
    .select("id, product_id, nome_snapshot, quantidade")
    .maybeSingle();
  if (error) return falhaInterna("internal_error", error, { requestId });
  if (!apagado) return fail("not_found", t("Produto do negócio não encontrado."), 404, { requestId });
  const a = apagado as { id: string; product_id: string | null; nome_snapshot: string; quantidade: number };

  const { data: lead } = await supabase
    .from("crm_leads")
    .select("contact_id")
    .eq("organization_id", org.orgId)
    .eq("id", leadId)
    .maybeSingle();

  await registrarAtividadeDeItem(supabase, {
    tipo: "lead_product_removed",
    organizationId: org.orgId,
    leadId,
    contactId: (lead as { contact_id: string | null } | null)?.contact_id ?? null,
    actor: { type: "user", id: user.id },
    produtoId: a.product_id,
    nome: a.nome_snapshot,
    quantidade: a.quantidade,
    requestId,
  });

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "lead.product_removed",
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId,
    metadata: { item_id: itemId, product_id: a.product_id, quantidade: a.quantidade },
  });

  return ok({ id: itemId, lead_value_cents: await valorDoNegocio(supabase, org.orgId, leadId) }, { requestId });
}
