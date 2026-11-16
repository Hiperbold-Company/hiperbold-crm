import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/channels/instancia/[id]/reconectar  — gera (ou renova) o QR Code, ou o código com o
 * número (`{ telefone }`), para RECONECTAR uma conexão que já existe e caiu.
 *
 * Não cria instância, não consome vaga do plano, não apaga nada: o QR é pedido na MESMA instância,
 * com o token dela guardado na linha. Se o número já voltou sozinho, a resposta já é `conectado`.
 * O estado (aguardando, expirado, conectado) é `POST .../reconectar/verificar`.
 *
 * Exige administrador ou gerente (o mesmo piso da tela de Conexões e do pareamento). A conexão é
 * procurada SEMPRE com o `organization_id` da sessão autenticada: o id de outra organização responde
 * 404, igual a um id que não existe. O QR só viaja nesta resposta; nunca vai para log nem audit.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { dentroDoLimiteDoPareamentoQr } from "@/lib/channels/pareamento-qr-limite";
import { iniciarReconexao, respostaDaReconexao } from "@/lib/channels/reconexao";
import { urlDoWebhookDeCanal } from "@/lib/channels/url-do-webhook";
import { traduzir } from "@/lib/i18n/dicionario";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();
const corpoSchema = z.object({
  /** Opcional: com o número, o servidor devolve um código para digitar no celular em vez do QR. */
  telefone: z.string().trim().max(30).nullish(),
});

type Contexto = { params: Promise<{ id: string }> };

const FRASE_MUITAS_TENTATIVAS =
  "Muitas tentativas de conectar. Aguarde um pouco antes de gerar outro QR Code.";

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
  const corpo = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!corpo.success) return fail("invalid_request", t("Dados inválidos."), 422, { requestId });
  // Só é pedido de CÓDIGO quando há número válido (só dígitos). Sem dígitos = QR comum; dígitos fora do
  // tamanho seguem para a reconexão, que recusa com 422 sem contar na cota de códigos.
  const digitos = (corpo.data.telefone ?? "").replace(/\D/g, "");
  const telefone = digitos || null;
  const pedeCodigo = /^\d{10,15}$/.test(digitos);

  if (!(await dentroDoLimiteDoPareamentoQr("reconectar", authz.org.orgId))) {
    return fail("rate_limited", t(FRASE_MUITAS_TENTATIVAS), 429, {
      requestId,
      headers: { "Retry-After": "3600" },
    });
  }
  if (pedeCodigo && !(await dentroDoLimiteDoPareamentoQr("reconectar_codigo", authz.org.orgId))) {
    return fail("rate_limited", t("Já foram pedidos códigos demais. Leia o QR Code ou tente mais tarde."), 429, {
      requestId,
      headers: { "Retry-After": "3600" },
    });
  }

  const r = await iniciarReconexao(createAdminClient(), {
    organizationId: authz.org.orgId,
    id: sessaoId,
    telefone,
    urlDoWebhook: urlDoWebhookDeCanal(),
  });
  if ("ok" in r) return fail(r.codigo, t(r.reason), r.status, { requestId });

  const base = {
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: sessaoId,
    requestId,
    ip: ipDoCliente(req.headers),
    userAgent: req.headers.get("user-agent") ?? null,
  };
  if (r.estado === "conectado") {
    if (r.concluiuAgora) {
      void audit({
        ...base,
        action: "channel.connected",
        // Nunca o número, o QR nem o token.
        metadata: { via: "reconexao", webhook_registrado: r.webhook.registrado, numero_mudou: r.numeroMudou },
      });
    }
  } else {
    void audit({
      ...base,
      action: "channel.reconnect_started",
      // Nunca o QR, o código, o número nem o token.
      metadata: { via: "reconexao", com_codigo: pedeCodigo },
    });
  }

  return ok(respostaDaReconexao(r), { requestId });
}
