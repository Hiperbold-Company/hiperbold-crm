import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/channels/instancia/[id]/reconectar/verificar  — o estado da reconexão: aguardando (com
 * o QR atualizado), expirado ou conectado.
 *
 * É POST porque TEM efeito: quando o número volta, é esta chamada que grava `WORKING` (e o número, se
 * mudou), confere a volta das mensagens e fecha o aviso de conexão caída. Expirado NÃO desfaz nada: a
 * conexão e a instância ficam, e a tela oferece gerar outro QR.
 *
 * Exige administrador ou gerente. A conexão é procurada SEMPRE com o `organization_id` da sessão
 * autenticada (nunca do path nem do corpo): id de outra organização responde 404.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { dentroDoLimiteDoPareamentoQr } from "@/lib/channels/pareamento-qr-limite";
import { respostaDaReconexao, verificarReconexao } from "@/lib/channels/reconexao";
import { urlDoWebhookDeCanal } from "@/lib/channels/url-do-webhook";
import { traduzir } from "@/lib/i18n/dicionario";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

type Contexto = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Contexto): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channels_reconexao" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = idSchema.safeParse((await params).id);
  if (!id.success) return fail("invalid_request", t("id da conexão inválido"), 422, { requestId });
  const sessaoId = id.data;

  if (!(await dentroDoLimiteDoPareamentoQr("reconectar_verificar", authz.org.orgId))) {
    return fail("rate_limited", t("Consultas demais. Aguarde um instante e tente de novo."), 429, {
      requestId,
      headers: { "Retry-After": "1" },
    });
  }

  const r = await verificarReconexao(createAdminClient(), {
    organizationId: authz.org.orgId,
    id: sessaoId,
    urlDoWebhook: urlDoWebhookDeCanal(),
  });
  if ("ok" in r) return fail(r.codigo, t(r.reason), r.status, { requestId });

  if (r.estado === "conectado" && r.concluiuAgora) {
    void audit({
      action: "channel.connected",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: sessaoId,
      requestId,
      ip: ipDoCliente(req.headers),
      userAgent: req.headers.get("user-agent") ?? null,
      // Nunca o número, o QR nem o token.
      metadata: { via: "reconexao", webhook_registrado: r.webhook.registrado, numero_mudou: r.numeroMudou },
    });
  }

  return ok(respostaDaReconexao(r), { requestId });
}
