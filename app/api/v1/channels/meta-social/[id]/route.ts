/**
 * DELETE /api/v1/channels/meta-social/[id] — desconecta uma conta do Instagram
 * ou do Messenger da PRÓPRIA organização (a do cookie). Arquiva a sessão (o
 * histórico continua), apaga o token da linha e tenta, best-effort, tirar a
 * assinatura do webhook na Meta. Arquivar libera a conta para ser conectada de
 * novo, aqui ou em outra organização.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { CHANNEL_PROVIDER_META_SOCIAL } from "@/lib/channels/capabilities";
import { arquivarConta } from "@/lib/channels/meta-social/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const parametros = z.object({ id: z.uuid() });

export async function DELETE(_req: Request, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await requireRole("admin", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const lido = parametros.safeParse(await ctx.params);
  if (!lido.success) return fail("validation_error", "Conexão inválida.", 400, { requestId });

  try {
    const r = await arquivarConta(createAdminClient(), auth.org.orgId, lido.data.id);
    if (!r) return fail("not_found", "Conexão não encontrada.", 404, { requestId });
    void audit({
      action: "channel.archived",
      organizationId: auth.org.orgId,
      actorUserId: auth.user.id,
      resourceType: "channel_session",
      resourceId: lido.data.id,
      requestId,
      metadata: {
        provider: CHANNEL_PROVIDER_META_SOCIAL,
        plataforma: r.plataforma,
        conta_id: r.contaId,
        desassinado: r.desassinado,
      },
    });
    return ok({ id: lido.data.id, arquivado: true, desassinado: r.desassinado }, { requestId });
  } catch {
    return fail("internal_error", "Não foi possível desconectar a conta.", 500, { requestId });
  }
}
