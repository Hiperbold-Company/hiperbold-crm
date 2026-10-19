/**
 * GET /api/v1/leads/[id]/timeline
 *
 * A timeline do NEGÓCIO — irmã da timeline do CONTATO, e não a mesma coisa.
 *
 * POR QUE ESTA ROTA EXISTE: o dossiê usava a timeline do contato, que é
 * indexada por `contact_id`. Lead SEM contato não tinha porta de entrada
 * nenhuma, e o dossiê de um negócio com quatro atividades dizia na tela "Nada
 * aconteceu com este negócio ainda". Medido: 14 de 55 leads sem contato (25%) e
 * 126 de 198 atividades pertencendo a eles (64%) — não é caso de canto, é a
 * maioria do que está registrado.
 *
 * E o defeito não estava NA peça: a timeline do contato está correta sobre o
 * contato. Ela foi reusada como dossiê do negócio, que é outro substantivo.
 * Vazio por falta de EIXO se lê idêntico a vazio por falta de ACONTECIMENTO — e
 * a frase estava na frente do cliente afirmando o que não era verdade.
 *
 * A CLÁUSULA: âncora no lead, unida com `contact_id = <contato do lead> and
 * lead_id is null`.
 *
 *  - o segundo lado NÃO casa linha nenhuma hoje, e o banco garante que não casa:
 *    `crm_lead_activities.lead_id` é NOT NULL, então não existe atividade "da
 *    conversa" sem negócio. Ele fica como defesa de intenção (se a coluna um dia
 *    aceitar nulo, a atividade de conversa aparece), não como caminho que
 *    devolva dado;
 *  - o irmão fica de fora POR CONSTRUÇÃO: atividade do negócio B tem
 *    `lead_id = B`, e não casa com nenhum dos dois lados. A rota do contato,
 *    por puxar todos os leads dele, somava no dossiê de A o que era de B;
 *  - lead sem contato passa a ter porta com o primeiro lado sozinho.
 *
 * ESCOPO POR CONTATO (`?escopo=contato`, out/2026): a ficha do negócio passou a
 * mostrar a história da PESSOA — as atividades de TODOS os negócios do contato —
 * e a rota anexa a cada linha o negócio e o funil de origem. É decisão do dono do
 * produto e vale só quando pedida: sem o parâmetro, o eixo é o do negócio, como
 * acima (e o irmão fica de fora). Lead sem contato cai no eixo do negócio, nos
 * dois casos.
 *
 * Como o filtro é montado: `crm_leads!inner(contact_id)` + `crm_leads.contact_id =
 * <contato>`, uma junção no banco — nenhuma lista de ids na URL, que cresceria com
 * o número de negócios do contato. A RLS vale nas duas tabelas, então em
 * visibilidade `own` o negócio de outro dono não entra (provado em
 * `tests/invariants/evento-manual-autoria-e-escopo-contato.test.ts`). `lead_id` é
 * NOT NULL em `crm_lead_activities`: toda atividade pertence a um negócio, e o
 * critério é o contato DO NEGÓCIO. Uma atividade antiga com `contact_id` do
 * contato mas de negócio que hoje é de outro contato não entra.
 *
 * ⚠️ NÃO "SIMPLIFIQUE" O SEGUNDO LADO sem ler `timeline-eixo.test.ts`: ele prende
 * as propriedades da cláusula. O que ele NÃO deve ser é descrito como se
 * devolvesse dado hoje — `lead_id` NOT NULL diz que não devolve.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import {
  TIMELINE_COLS,
  comNomeDoAtor,
  comOrigemDoNegocio,
  decodeCursor,
  eixoDoDossie,
  encodeCursor,
} from "@/lib/leads/timeline-query";
import { ehUuid } from "@/lib/query/cursor-seguro";
import type { TimelineItem } from "@/lib/types/contacts";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;
  // Id que não é UUID nunca chega ao banco: seria 22P02 (500) em vez de 404.
  if (!ehUuid(leadId)) {
    return fail("not_found", traduzir("Negócio não encontrado.", "pt-BR"), 404, { requestId });
  }

  const supabase = await createClient();
  // D-092: a leitura passa pelo gate único (papel efetivo e MFA da sessão), não
  // só pela RLS: ela não olha o nível da sessão.
  const authz = await requireRole("viewer", { requestId, resource: "leads" });
  if (!authz.ok) return authz.response;
  const authUser = authz.user;
  const organizationId = authz.org.orgId;
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");

  const url = new URL(req.url);
  const types = url.searchParams.getAll("type").filter(Boolean);
  const limitRaw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50;
  const porContato = url.searchParams.get("escopo") === "contato";
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
  }

  // O lead vem pela RLS do caller — é ele que prova a org, nunca o body.
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (leadErr) return falhaInterna("internal_error", leadErr, { requestId });
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const contactId = (lead as { contact_id: string | null }).contact_id;

  // Escopo contato: a junção com o negócio entra no SELECT (e sai da resposta).
  const porContatoDoNegocio = porContato && !!contactId;
  const colunas = porContatoDoNegocio ? `${TIMELINE_COLS}, crm_leads!inner(contact_id)` : TIMELINE_COLS;
  let q = supabase
    .from("crm_lead_activities")
    .select(colunas)
    .eq("organization_id", organizationId)
    .order("performed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  // A cláusula mora em `eixoDoDossie` — não aqui — porque é ela que o teste
  // prende. Sem contato ela devolve null e o filtro vira igualdade simples: é
  // isso que dá porta ao lead que antes não tinha nenhuma.
  if (porContatoDoNegocio) {
    q = q.eq("crm_leads.contact_id", contactId as string);
  } else {
    const eixo = eixoDoDossie(leadId, contactId);
    q = eixo ? q.or(eixo) : q.eq("lead_id", leadId);
  }

  if (types.length > 0) q = q.in("type", types);
  if (cursor) {
    q = q.or(
      `performed_at.lt.${cursor.performed_at},and(performed_at.eq.${cursor.performed_at},id.lt.${cursor.id})`,
    );
  }

  const { data, error } = await q;
  if (error) return falhaInterna("internal_error", error, { requestId });

  // `crm_leads` é só o instrumento do filtro; não vai para o cliente.
  const rows = ((data ?? []) as unknown as Array<TimelineItem & { crm_leads?: unknown }>).map(
    ({ crm_leads: _juncao, ...linha }) => linha as TimelineItem,
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const comAtor = await comNomeDoAtor(supabase, pageRows);
  const page = porContato ? await comOrigemDoNegocio(supabase, comAtor, organizationId) : comAtor;
  const last = pageRows[pageRows.length - 1];

  return ok(page, {
    requestId,
    meta: {
      has_more: hasMore,
      cursor: hasMore && last ? encodeCursor({ performed_at: last.performed_at, id: last.id }) : null,
    },
  });
}
