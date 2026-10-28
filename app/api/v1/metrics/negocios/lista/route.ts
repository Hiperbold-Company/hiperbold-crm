/**
 * GET /api/v1/metrics/negocios/lista — a tabela de negócios da aba Negócios,
 * paginada no servidor (20 por página).
 *
 * `tipo` escolhe o mesmo recorte do cartão: criados, ganhos, perdidos e em
 * aberto no período, ou a carteira inteira de abertos. As regras são as de
 * `fn_desempenho_negocios` (0981): perda por troca de funil não entra.
 *
 * Leitura com o client da SESSÃO: a RLS de crm_leads escopa o atendente aos
 * negócios que ele já vê; `organization_id` filtrado também, da sessão.
 * Read-only ⇒ sem audit.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, falhaInterna, ok } from "@/lib/api/wrappers";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { TIPOS_DA_LISTA, diasEntre, progressoNaEtapa } from "@/lib/metrics/desempenho";
import { nomesDasPessoas } from "@/lib/metrics/nomes";
import { abrirPedidoDeDesempenho } from "@/lib/metrics/rota-desempenho";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const POR_PAGINA = 20;

const listaSchema = z.object({
  tipo: z.enum(TIPOS_DA_LISTA).default("criados"),
  pagina: z.coerce.number().int().min(1).max(10_000).default(1),
});

interface LinhaDoBanco {
  id: string;
  title: string;
  status: string;
  value_cents: number | null;
  currency: string | null;
  tags: string[] | null;
  created_at: string;
  closed_at: string | null;
  stage_changed_at: string | null;
  owner_user_id: string | null;
  pipeline_id: string;
  stage_id: string;
  contato: { display_name: string | null; name: string | null } | null;
  etapa: { name: string } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const pedido = await abrirPedidoDeDesempenho(req);
  if (!pedido.ok) return pedido.response;
  const { t, requestId } = pedido;

  const parsed = listaSchema.safeParse({
    tipo: pedido.url.searchParams.get("tipo") ?? undefined,
    pagina: pedido.url.searchParams.get("pagina") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }
  const { tipo, pagina } = parsed.data;
  const from = pedido.from.toISOString();
  const to = pedido.to.toISOString();

  const supabase = await createClient();
  let q = supabase
    .from("crm_leads")
    .select(
      "id, title, status, value_cents, currency, tags, created_at, closed_at, stage_changed_at, owner_user_id, pipeline_id, stage_id, contato:contacts!crm_leads_contact_id_fkey(display_name, name), etapa:crm_stages!crm_leads_stage_id_fkey(name)",
      { count: "exact" },
    )
    .eq("organization_id", pedido.orgId);
  if (pedido.pipelineId) q = q.eq("pipeline_id", pedido.pipelineId);
  if (pedido.ownerUserId) q = q.eq("owner_user_id", pedido.ownerUserId);

  switch (tipo) {
    case "criados":
      q = q.gte("created_at", from).lt("created_at", to).order("created_at", { ascending: false });
      break;
    case "em_aberto":
      q = q.eq("status", "open").gte("created_at", from).lt("created_at", to).order("created_at", { ascending: false });
      break;
    case "ganhos":
      q = q.eq("status", "won").gte("closed_at", from).lt("closed_at", to).order("closed_at", { ascending: false });
      break;
    case "perdidos":
      q = q
        .eq("status", "lost")
        .neq("lost_reason", "moved_to_another_pipeline")
        .gte("closed_at", from)
        .lt("closed_at", to)
        .order("closed_at", { ascending: false });
      break;
    case "carteira":
      q = q.eq("status", "open").order("created_at", { ascending: false });
      break;
  }

  const inicio = (pagina - 1) * POR_PAGINA;
  const { data, error, count } = await q.order("id").range(inicio, inicio + POR_PAGINA - 1);
  if (error) return falhaInterna("internal_error", error, { requestId });
  const linhas = (data ?? []) as unknown as LinhaDoBanco[];

  // A barra de progresso precisa da ordem das etapas de cada funil da página.
  const funis = [...new Set(linhas.map((l) => l.pipeline_id))];
  const etapasPorFunil = new Map<string, string[]>();
  if (funis.length > 0) {
    const { data: etapas, error: errEtapas } = await supabase
      .from("crm_stages")
      .select("id, pipeline_id, position")
      .eq("organization_id", pedido.orgId)
      .eq("is_archived", false)
      .in("pipeline_id", funis)
      .order("position");
    if (errEtapas) return falhaInterna("internal_error", errEtapas, { requestId });
    for (const e of etapas ?? []) {
      const lista = etapasPorFunil.get(e.pipeline_id) ?? [];
      lista.push(e.id);
      etapasPorFunil.set(e.pipeline_id, lista);
    }
  }

  const nomes = await nomesDasPessoas(linhas.map((l) => l.owner_user_id));
  const agora = new Date();

  return ok(
    {
      tipo,
      pagina,
      por_pagina: POR_PAGINA,
      total: count ?? 0,
      negocios: linhas.map((l) => {
        const criado = new Date(l.created_at);
        const fim = l.closed_at ? new Date(l.closed_at) : agora;
        return {
          id: l.id,
          titulo: l.title,
          contato: nomeDoContato(l.contato),
          tags: l.tags ?? [],
          status: l.status,
          value_cents: l.value_cents,
          currency: l.currency,
          owner_user_id: l.owner_user_id,
          owner_name: l.owner_user_id ? (nomes.get(l.owner_user_id) ?? null) : null,
          etapa: l.etapa?.name ?? null,
          progresso: progressoNaEtapa(l.stage_id, etapasPorFunil.get(l.pipeline_id) ?? []),
          dias_em_aberto: diasEntre(criado, fim),
          dias_na_etapa:
            l.status === "open" ? diasEntre(new Date(l.stage_changed_at ?? l.created_at), agora) : null,
        };
      }),
    },
    { requestId },
  );
}
