/**
 * POST /api/v1/leads/[id]/activities
 *
 * Registra à mão um evento na linha do tempo do negócio — ligação, reunião,
 * e-mail, conversa de WhatsApp fora do CRM, nota. É o "Registrar evento" da ficha.
 *
 * Como é gravado, e por que a data vai em `performed_at`: ver
 * `lib/leads/evento-manual.ts`.
 *
 * ─── Quem pode, e de onde vem a organização ──────────────────────────────────
 *
 *  - papel mínimo `agent` (viewer é só leitura), pelo gate único `requireRole`;
 *  - a organização sai da sessão, NUNCA do corpo. O negócio é lido pelo cliente
 *    do chamador (RLS) E com `organization_id` explícito: negócio de outra
 *    organização é 404, igual a negócio que não existe, para a resposta não
 *    confirmar que o id existe em outro lugar;
 *  - `contact_id` da atividade vem do NEGÓCIO, não do corpo;
 *  - só sessão. Esta rota não aceita `Bearer dsk_…`: o autor do evento é uma
 *    PESSOA (aparece na linha do tempo como quem escreveu), e uma chave de
 *    integração viraria "Sistema". Habilitar bearer é por rota e exigiria entrada
 *    em `lib/auth/public-paths.ts`; fica para quando uma integração precisar.
 *
 * `requireSupportWrite` abre o handler, antes de qualquer efeito: acompanhamento
 * de suporte somente-leitura não escreve na linha do tempo do cliente.
 *
 * Sem rate limit próprio: as rotas irmãs de `leads/[id]` (move, lose, clone) não
 * têm, e a escrita é uma linha por clique de uma pessoa autenticada.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { exigirPermissao } from "@/lib/permissoes/servidor";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import {
  ORIGEM_DO_EVENTO_MANUAL,
  estaNoFuturo,
  eventoManualSchema,
} from "@/lib/leads/evento-manual";
import { ehUuid } from "@/lib/query/cursor-seguro";
import { validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;
  // Id que não é UUID nunca chega ao banco: seria 22P02 (500) em vez de 404.
  if (!ehUuid(leadId)) {
    return fail("not_found", traduzir("Negócio não encontrado.", "pt-BR"), 404, { requestId });
  }

  const authz = await exigirPermissao("negocios.registrar", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma ?? "pt-BR");

  try {
    const input = await validateRequest(eventoManualSchema, req);

    if (input.occurred_at && estaNoFuturo(input.occurred_at)) {
      return fail(
        "occurred_at_in_future",
        t("A data do evento não pode ser no futuro."),
        422,
        { requestId },
      );
    }

    // "Agora" do navegador que chegou até 5 min adiantado vale como agora do
    // servidor: gravar o instante adiantado poria o evento no futuro da timeline
    // (e a policy 0970 recusa performed_at além dessa folga).
    const agoraMs = Date.now();
    const instante = input.occurred_at ? new Date(input.occurred_at).getTime() : null;
    const performedAt = instante !== null && instante <= agoraMs ? input.occurred_at : undefined;

    const supabase = await createClient();
    const { data: lead, error: leadErr } = await supabase
      .from("crm_leads")
      .select("id, contact_id")
      .eq("id", leadId)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (leadErr) return falhaInterna("internal_error", leadErr, { requestId });
    if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

    const row = buildLeadActivityRow({
      organizationId: org.orgId,
      leadId,
      contactId: (lead as { contact_id: string | null }).contact_id,
      type: "note",
      sourceModule: ORIGEM_DO_EVENTO_MANUAL,
      actor: { type: "user", id: user.id },
      // O porquê legível; o TEXTO da pessoa mora no payload (a linha do tempo o
      // mostra inteiro), não aqui — `reason` é para frase curta sem PII.
      reason: "Registro manual",
      payload: { subtype: input.subtype, text: input.text },
    });

    const { data: criada, error: insErr } = await supabase
      .from("crm_lead_activities")
      .insert({ ...row, ...(performedAt ? { performed_at: performedAt } : {}) })
      .select("id, performed_at, created_at")
      .single();
    if (insErr || !criada) {
      return falhaInterna("internal_error", insErr ?? new Error("insert sem retorno"), { requestId });
    }

    await audit({
      action: "lead.activity_logged",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata: {
        actor_type: "user",
        activity_id: (criada as { id: string }).id,
        subtype: input.subtype,
        text_length: input.text.length,
        backdated: Boolean(performedAt),
      },
    });

    return ok(
      {
        id: (criada as { id: string }).id,
        lead_id: leadId,
        type: "note",
        subtype: input.subtype,
        text: input.text,
        performed_at: (criada as { performed_at: string }).performed_at,
        created_at: (criada as { created_at: string }).created_at,
      },
      { requestId, status: 201 },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
