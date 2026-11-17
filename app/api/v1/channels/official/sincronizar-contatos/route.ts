/**
 * POST /api/v1/channels/official/sincronizar-contatos: "tentar de novo" a sincronização dos contatos do
 * app WhatsApp Business (coexistência).
 *
 * Existe porque o Cadastro Incorporado pede essa sincronização à Meta logo depois de conectar, e a
 * chamada pode falhar sem desfazer a conexão (`sincronizacaoDoApp: false`). Sem esta rota a tela só
 * mostraria "Conectado" e os contatos do celular nunca chegariam. A Meta pode recusar o pedido (por
 * exemplo, fora da janela que ela admite depois do cadastro): o motivo volta ao operador.
 *
 * ─── A ORGANIZAÇÃO VEM SÓ DA SESSÃO ──────────────────────────────────────────
 * O corpo traz o `channel_session_id` da conexão que a tela mostra, e a rota só CONFERE que ele é a
 * sessão oficial viva DESTA organização. Id de outra organização, arquivado ou inexistente é 404, sem
 * distinguir um do outro e sem falar com a Meta. O token sai decifrado da sessão e nunca volta.
 *
 * Rota de cookie, como as demais de `/api/v1/channels`: o `proxy.ts` exige a sessão, e por isso não há
 * entrada em `lib/auth/public-paths.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { credenciaisDoCanalOficialVivo } from "@/lib/channels/meta/numero-da-sessao";
import { sincronizarContatosDoApp } from "@/lib/channels/meta/registro-do-numero";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store, max-age=0" } as const;

const corpoSchema = z.object({ channel_session_id: z.string().uuid() }).strict();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channels_official_sincronizar_contatos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Confira a conexão e tente de novo."), 422, { requestId, headers: NO_STORE });
  }

  const limite = await checkRateLimit(`sincronizar-contatos:${orgId}`, 5, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Aguarde um minuto antes de tentar novamente."), 429, {
      requestId,
      headers: { ...NO_STORE, "Retry-After": "60" },
    });
  }

  const cred = await credenciaisDoCanalOficialVivo(createAdminClient(), orgId);
  // A sessão viva da organização é a ÚNICA que vale: id que não é ela (de outra org, arquivado,
  // inventado) é 404, igual a "não há conexão", para a resposta não confirmar que o id existe fora daqui.
  if (!cred.ok && cred.erro === "no_meta_channel") return naoEncontrada(requestId, t);
  if (!cred.ok) {
    return fail(
      "invalid_request",
      t("Não foi possível ler a credencial da conexão. Reconecte o número pela Meta."),
      422,
      { requestId, headers: NO_STORE },
    );
  }
  if (cred.sessionId !== parsed.data.channel_session_id) return naoEncontrada(requestId, t);

  let sync: Awaited<ReturnType<typeof sincronizarContatosDoApp>>;
  try {
    sync = await sincronizarContatosDoApp({ phoneNumberId: cred.phoneNumberId, token: cred.token });
  } catch (err) {
    // Nunca o token: só o nome do erro.
    logger.warn("[sincronizar-contatos] a chamada à Meta falhou", {
      request_id: requestId,
      organization_id: orgId,
      erro: err instanceof Error ? err.name : "desconhecido",
    });
    sync = { ok: false, motivo: "falha de conexão" };
  }

  if (!sync.ok) {
    logger.warn("[sincronizar-contatos] a Meta recusou a sincronização", {
      request_id: requestId,
      organization_id: orgId,
      motivo: sync.motivo,
    });
  }

  // O pedido À META aconteceu, com sucesso ou recusa: é o efeito que se audita. Nunca o token.
  await audit({
    action: "channel.official_contacts_sync_requested",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: cred.sessionId,
    requestId,
    metadata: { phone_number_id: cred.phoneNumberId, aceita: sync.ok },
  });

  // A Meta recusar NÃO é erro de requisição: 200 com `sincronizado: false` e o motivo, como `/registrar`.
  return ok(
    { sincronizado: sync.ok, motivo: sync.ok ? null : sync.motivo },
    { requestId, headers: NO_STORE },
  );
}

function naoEncontrada(requestId: string, t: (texto: string) => string) {
  return fail("not_found", t("Conexão oficial não encontrada."), 404, { requestId, headers: NO_STORE });
}
