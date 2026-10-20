/**
 * GET  /api/v1/leads/:id/itens — os produtos do negócio.
 * POST /api/v1/leads/:id/itens — adiciona um produto do catálogo ao negócio.
 *
 * O VALOR do negócio é a soma destes itens (gatilho do banco, migration 0972):
 * a resposta do POST devolve o `value_cents` já somado, para a ficha mostrar o
 * número que o banco guarda e não um que ela calculou.
 *
 * ─── Quem pode, e de onde vem a organização ──────────────────────────────────
 *
 *  - leitura `viewer`, escrita `agent` (mesmo piso de editar o negócio), pelo
 *    gate único `requireRole`; `requireSupportWrite` abre o POST, antes de
 *    qualquer efeito;
 *  - a organização sai da sessão, NUNCA do corpo. Negócio e produto são lidos
 *    pelo cliente do chamador (RLS) E com `organization_id` explícito: de outra
 *    organização é 404, igual ao que não existe;
 *  - só sessão (como o "Registrar evento"): o autor aparece na linha do tempo.
 *
 * Produto de valor FIXO entra com o preço do catálogo (a ficha deixa editar);
 * produto de valor VARIÁVEL exige o valor no corpo — o valor do negócio não
 * pode nascer de um número que ninguém digitou.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, falhaInterna, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { precoDoCatalogoParaValorDoNegocio } from "@/lib/money";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { registrarAtividadeDeItem } from "@/lib/leads/itens-do-negocio";
import { ehUuid } from "@/lib/query/cursor-seguro";
import {
  COLUNAS_DO_ITEM_DO_NEGOCIO,
  itemDoNegocioCreateSchema,
  MAXIMO_DE_ITENS_POR_NEGOCIO,
  MENSAGEM_DO_TETO_DO_SUBTOTAL,
  SUBTOTAL_MAXIMO_CENTS,
  subtotalDoItem,
} from "@/lib/schemas/lead-itens";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;
  const authz = await requireRole("viewer", { requestId, resource: "crm_lead_itens" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma ?? "pt-BR");
  if (!ehUuid(leadId)) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_lead_itens")
    .select(COLUNAS_DO_ITEM_DO_NEGOCIO)
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAXIMO_DE_ITENS_POR_NEGOCIO);
  if (error) return falhaInterna("internal_error", error, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_itens" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma ?? "pt-BR");
  // Id que não é UUID nunca chega ao banco: seria 22P02 (500) em vez de 404.
  if (!ehUuid(leadId)) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const parsed = itemDoNegocioCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const input = parsed.data;

  const supabase = await createClient();

  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", org.orgId)
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return falhaInterna("internal_error", leadErr, { requestId });
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const { data: produto, error: prodErr } = await supabase
    .from("catalog_products")
    .select("id, nome, ativo, tipo_de_preco, preco_cents, moeda")
    .eq("organization_id", org.orgId)
    .eq("id", input.product_id)
    .maybeSingle();
  if (prodErr) return falhaInterna("internal_error", prodErr, { requestId });
  if (!produto) return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  const p = produto as {
    id: string;
    nome: string;
    ativo: boolean;
    tipo_de_preco: string;
    preco_cents: number | null;
    moeda: string;
  };
  if (!p.ativo) {
    return fail("validation_failed", t("Esse produto está desativado no catálogo."), 422, { requestId });
  }

  // O valor unitário: o do corpo, ou o preço de tabela do produto FIXO. Produto
  // variável sem valor é recusado — nunca se grava um número que ninguém digitou.
  // O preço do catálogo muda de régua ao entrar no negócio (ver a função).
  const valorUnitario =
    input.valor_unitario_cents ??
    (p.tipo_de_preco === "fixo" && p.preco_cents !== null
      ? precoDoCatalogoParaValorDoNegocio(p.preco_cents, p.moeda)
      : null);
  if (valorUnitario === null || valorUnitario === undefined) {
    return fail(
      "validation_failed",
      t("Esse produto tem valor variável: informe o valor deste negócio."),
      422,
      { requestId, details: { valor_unitario_cents: [t("informe o valor")] } },
    );
  }

  // O valor pode vir do catálogo (não passou pelo Zod): o teto do subtotal vale para os dois caminhos.
  if (subtotalDoItem({ quantidade: input.quantidade, valor_unitario_cents: valorUnitario }) > SUBTOTAL_MAXIMO_CENTS) {
    return fail("validation_failed", t(MENSAGEM_DO_TETO_DO_SUBTOTAL), 422, { requestId });
  }

  const { count, error: contErr } = await supabase
    .from("crm_lead_itens")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.orgId)
    .eq("lead_id", leadId);
  if (contErr) return falhaInterna("internal_error", contErr, { requestId });
  if ((count ?? 0) >= MAXIMO_DE_ITENS_POR_NEGOCIO) {
    return fail("validation_failed", t("Esse negócio já tem o máximo de produtos."), 422, { requestId });
  }

  const { data: item, error: insErr } = await supabase
    .from("crm_lead_itens")
    .insert({
      organization_id: org.orgId,
      lead_id: leadId,
      product_id: p.id,
      nome_snapshot: p.nome,
      quantidade: input.quantidade,
      valor_unitario_cents: valorUnitario,
    })
    .select(COLUNAS_DO_ITEM_DO_NEGOCIO)
    .single();
  // 23514 = CHECK (teto do subtotal, nome longo); PT422 = limite de itens do gatilho. Corpo/estado inválido, nunca 500.
  if (insErr && (insErr.code === "23514" || insErr.code === "PT422")) {
    return fail("validation_failed", t(insErr.code === "PT422" ? "Esse negócio já tem o máximo de produtos." : MENSAGEM_DO_TETO_DO_SUBTOTAL), 422, { requestId });
  }
  if (insErr || !item) {
    return falhaInterna("internal_error", insErr ?? new Error("insert sem retorno"), { requestId });
  }

  // O banco já somou (gatilho); devolve o que ele guarda.
  const { data: depois } = await supabase
    .from("crm_leads")
    .select("value_cents")
    .eq("organization_id", org.orgId)
    .eq("id", leadId)
    .maybeSingle();

  await registrarAtividadeDeItem(supabase, {
    tipo: "lead_product_added",
    organizationId: org.orgId,
    leadId,
    contactId: (lead as { contact_id: string | null }).contact_id,
    actor: { type: "user", id: user.id },
    produtoId: p.id,
    nome: p.nome,
    quantidade: input.quantidade,
    requestId,
  });

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "lead.product_added",
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId,
    metadata: {
      item_id: (item as { id: string }).id,
      product_id: p.id,
      quantidade: input.quantidade,
      valor_unitario_cents: valorUnitario,
    },
  });

  return ok(
    { item, lead_value_cents: (depois as { value_cents: number | null } | null)?.value_cents ?? null },
    { requestId, status: 201 },
  );
}
