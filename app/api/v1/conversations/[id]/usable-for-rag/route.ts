import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET/POST /api/v1/conversations/[id]/usable-for-rag
 *
 * "Usar para ensinar o agente" (LGPD L-08). Marcada, a conversa entra no lote
 * diário `kb-conversations-batch`, que anonimiza, divide e indexa o diálogo na
 * fonte "Conversas anteriores" do Conhecimento. Quem marca é o botão do Chat
 * (`components/inbox/EnsinarAgenteButton.tsx`).
 *
 * Auth: sessão de cookie, papel >= agent — o mesmo piso de encerrar a conversa
 * (`/close`). Organização sempre da sessão, nunca do corpo.
 * Audit: `conversation.usable_for_rag_toggled`, só quando o estado muda.
 *
 * Três regras que a tela promete e a rota cumpre:
 *  - só conversa ENCERRADA (`conversaPodeEnsinar`) pode ser marcada: o lote só
 *    lê encerradas, e uma marcação em conversa aberta ficava parada na fila;
 *  - marcar ou desmarcar duas vezes não muda nada nem gera auditoria nova;
 *  - `rag_review_status = 'ingested'` NUNCA é apagado por aqui. Desmarcar não
 *    tira da base o que o lote já indexou (nenhum código remove esses trechos),
 *    e zerar o status fazia a conversa ser indexada de novo, em dobro, se
 *    alguém a marcasse outra vez.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { validateRequest } from "@/lib/schemas/_validate";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { conversaPodeEnsinar, type EstadoDoEnsino } from "@/lib/ai/rag/conversa-que-ensina";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ enabled: z.boolean() }).strict();

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface LinhaDaConversa {
  id: string;
  status: string;
  usable_for_rag: boolean;
  usable_for_rag_marked_at: string | null;
  rag_review_status: EstadoDoEnsino["rag_review_status"];
}

const COLUNAS = "id, status, usable_for_rag, usable_for_rag_marked_at, rag_review_status";

function estado(linha: LinhaDaConversa): EstadoDoEnsino {
  return {
    conversation_id: linha.id,
    usable_for_rag: linha.usable_for_rag,
    usable_for_rag_marked_at: linha.usable_for_rag_marked_at,
    rag_review_status: linha.rag_review_status,
    pode_marcar: conversaPodeEnsinar(linha.status),
  };
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversations")
    .select(COLUNAS)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (error) return falhaInterna("internal_error", error, { requestId });
  if (!data) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  return ok(estado(data as LinhaDaConversa), { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(bodySchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();

  const { data: atualRow, error: leituraErr } = await supabase
    .from("conversations")
    .select(COLUNAS)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (leituraErr) return falhaInterna("internal_error", leituraErr, { requestId });
  if (!atualRow) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }
  const atual = atualRow as LinhaDaConversa;

  // Já está no estado pedido: nada muda, nada se audita.
  if (atual.usable_for_rag === input.enabled) {
    return ok(estado(atual), { requestId });
  }

  if (input.enabled && !conversaPodeEnsinar(atual.status)) {
    return fail(
      "invalid_state",
      t("Só uma conversa encerrada pode ensinar o agente. Encerre a conversa e marque de novo."),
      409,
      { requestId },
    );
  }

  const jaNaBase = atual.rag_review_status === "ingested";
  const update = input.enabled
    ? {
        usable_for_rag: true,
        usable_for_rag_marked_at: new Date().toISOString(),
        usable_for_rag_marked_by: authUser.id,
        rag_review_status: jaNaBase ? "ingested" : null,
      }
    : {
        usable_for_rag: false,
        usable_for_rag_marked_at: null,
        usable_for_rag_marked_by: null,
        rag_review_status: jaNaBase ? "ingested" : null,
      };

  const { data, error } = await supabase
    .from("conversations")
    .update(update)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select(COLUNAS)
    .maybeSingle();

  if (error) {
    return falhaInterna("internal_error", error, { requestId });
  }
  if (!data) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  await audit({
    action: "conversation.usable_for_rag_toggled",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "conversation",
    resourceId: id,
    metadata: {
      conversation_id: id,
      enabled: input.enabled,
      prev: atual.usable_for_rag,
      ja_na_base: jaNaBase,
    },
    requestId,
  });

  return ok(estado(data as LinhaDaConversa), { requestId });
}
