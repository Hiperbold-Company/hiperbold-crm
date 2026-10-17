import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channel-sessions — lista os canais WhatsApp da org (do DB).
 *   Acessível a qualquer membro (usado pelo seletor do inbox e pela sidebar) e a chave `dsk_…` com `mcp:read`
 *   (só leitura; regra em `lib/channels/listar-conexoes.ts`, sem segredo).
 * POST /api/v1/channel-sessions — conecta um NOVO número (cria a sessão com
 *   nome único e inicia no WAHA). Admin only.
 *
 * organization_id resolvido da sessão (cookie) — nunca do body.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { connectWahaChannel, ChannelConnectionError } from "@/lib/channels/connect-waha";
import { createAdminClient } from "@/lib/supabase/admin";
import { mfaEmDivida } from "@/lib/auth/server";
import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { autorizarAdministracao } from "@/lib/api/auth-dual-admin";
import { listarConexoesDeMensagem } from "@/lib/channels/listar-conexoes";
import { createChannelSchema } from "@/lib/schemas/channels";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient } from "@/lib/waha/client";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  // Sessão OU token (`viewer`+ e `mcp:read`). Qualquer membro lista (seletor do inbox, sidebar); uma chave só lê.
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "channel_sessions",
    role: "viewer",
    escrita: false,
  });
  if (!authz.ok) return authz.response;

  const { data, error, schemaOutdated } = await listarConexoesDeMensagem(authz.supabase, authz.organizationId);
  if (error) return falhaInterna("internal_error", error, { requestId });

  return ok(data ?? [], {
    requestId,
    ...(schemaOutdated ? { meta: { schema_outdated: true } } : {}),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;
  if (await mfaEmDivida()) return fail("mfa_required", t("Confirme a verificação em duas etapas."), 403, { requestId });

  const waha = getWahaClient();
  if (!waha) {
    return fail(
      "waha_not_configured",
      t("O WhatsApp (WAHA) não está configurado neste ambiente: faltam WAHA_API_BASE_URL e/ou WAHA_API_KEY. Configure-as e tente de novo."),
      503,
      { requestId },
    );
  }

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createChannelSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  try {
    const result = await connectWahaChannel(await createClient(), createAdminClient(), waha, {
      organizationId: activeOrg.orgId, idempotencyKey: req.headers.get("Idempotency-Key") ?? "",
      userId: user.id, requestId, displayName: parsed.data.display_name,
    });
    return ok(result.channel, { requestId, status: result.replay ? 200 : 201 });
  } catch (error) {
    if (error instanceof ChannelConnectionError) return fail(error.code,
      error.code === "connection_in_progress" ? t("A conexão ainda está sendo preparada. Aguarde e tente novamente.")
        : error.code === "connection_session_name_too_long" ? t("O identificador desta conexão passou do limite que o WhatsApp aceita. Nada foi criado no WhatsApp — atualize o sistema e tente novamente.")
        : t("Não foi possível concluir a conexão. Abra Conexões para tentar novamente ou reparar o número."),
      error.status, { requestId, details: error.technical });
    return fail("internal_error", t("Não foi possível concluir a conexão. Tente novamente."), 500, { requestId });
  }
}
