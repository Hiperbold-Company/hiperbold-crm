/**
 * GET /api/v1/contacts/[id]/compras — as "Últimas compras" do contato (#3179).
 *
 * POR QUE UMA ROTA (e não o `crm-summary`): o painel do Inbox e a FICHA do contato
 * mostram a mesma seção, e a ficha não tem o `crm-summary` no caminho. Uma leitura
 * só, num lugar só, serve aos dois — e a régua de "o que é compra" (negócio GANHO,
 * em todos os funis) fica escrita uma vez, em `lib/leads/compras-do-contato.ts`.
 *
 * UMA consulta por contato, como o caminho medido pede: `status='won'`, de TODOS
 * os funis (a lista não filtra por funil nem por arquivado — o histórico de compra
 * do cliente não desaparece porque o quadro saiu da vista), ordenada pela data do
 * ganho. Os campos escolhidos pela organização vêm da preferência que JÁ existe
 * (`organizations.interface_settings.compras_campos`) — nenhuma tabela nova.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { montarCompras, type LeadGanhoRow } from "@/lib/leads/compras-do-contato";
import { chavesRestritasDaOrganizacao } from "@/lib/campos/chaves-restritas";
import { leitorDoAtor, leitorVeCamposRestritos, recortarLinha } from "@/lib/campos/recorte-por-papel";
import { camposDeCompraDaInterface } from "@/lib/navigation/interface";

export const dynamic = "force-dynamic";

/** O embed do funil alimenta os RÓTULOS dos campos escolhidos (título da coluna). */
const COMPRA_COLS =
  "id, title, status, value_cents, recurring_value_cents, recurring_period, recurring_months, currency, closed_at, pipeline_id, custom_fields, crm_pipelines(settings)";

/** A janela da lista: o suficiente para o histórico do atendimento, sem paginar. */
const LIMITE = 20;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  // A RLS já limita o que este usuário enxerga; a organização vem da LINHA do
  // contato (nunca do corpo) e o filtro por ela é explícito, como no crm-summary.
  const { data: contactScope, error: scopeError } = await supabase
    .from("contacts")
    .select("organization_id")
    .eq("id", contactId)
    .maybeSingle();
  if (scopeError) return falhaInterna("internal_error", scopeError, { requestId });
  if (!contactScope) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("interface_settings")
    .eq("id", contactScope.organization_id)
    .maybeSingle();
  if (orgError) return falhaInterna("internal_error", orgError, { requestId });
  const chaves = camposDeCompraDaInterface(org?.interface_settings);

  const { data, error } = await supabase
    .from("crm_leads")
    .select(COMPRA_COLS)
    .eq("contact_id", contactId)
    .eq("organization_id", contactScope.organization_id)
    .eq("status", "won")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false })
    .limit(LIMITE);

  // A falha SOBE: engolir aqui devolveria lista vazia ao cliente — e "o cliente
  // não comprou nada" é uma afirmação sobre o negócio, não sobre a leitura.
  if (error) return falhaInterna("internal_error", error, { requestId });

  // 1015: campo restrito escolhido como coluna de compra só mostra o valor a administrador. O
  // papel é o do usuário na organização do CONTATO (a mesma que filtra a leitura); sem papel
  // legível, o leitor é o que não vê.
  let linhas = (data ?? []) as unknown as LeadGanhoRow[];
  if (chaves.length > 0 && linhas.length > 0) {
    const { data: membro } = await supabase
      .from("user_organizations")
      .select("role")
      .eq("organization_id", contactScope.organization_id)
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .maybeSingle();
    const leitor = leitorDoAtor({ type: "user", role: (membro as { role?: string } | null)?.role });
    if (!leitorVeCamposRestritos(leitor)) {
      const lidas = await chavesRestritasDaOrganizacao(supabase, contactScope.organization_id, requestId);
      if (!lidas.ok) return falhaInterna("internal_error", "chaves restritas ilegíveis", { requestId });
      linhas = linhas.map((l) => recortarLinha(l, lidas.chaves, leitor));
    }
  }
  const compras = montarCompras(linhas, chaves);
  return ok({ compras }, { requestId });
}
