import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * O membro responsável pela conexão (migration 1019): UM membro ou nenhum (`null`).
 *
 * Só marca o padrão do seletor de conexão do painel do negócio. NÃO é o responsável do
 * roteamento (`channel_routing_responsibles`, Configurações › Atendimento) e não dá nem tira
 * permissão de envio.
 */
const responsavelSchema = z.object({ user_id: z.uuid().nullable() }).strict();

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Gerente ou administrador: o piso da tela de Conexões e da rota irmã do nome.
  const auth = await requireRole("manager", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", "Canal inválido.", 422, { requestId });

  const parsed = responsavelSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Escolha um membro da equipe ou nenhum.", 422, { requestId });
  const novo = parsed.data.user_id;

  const db = createAdminClient();
  const { data: before, error: readError } = await db
    .from("channel_sessions")
    .select("responsible_user_id")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (readError)
    return fail("internal_error", "Não foi possível ler a conexão.", 500, { requestId });
  if (!before) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const anterior = (before as { responsible_user_id?: string | null }).responsible_user_id ?? null;
  if (anterior === novo) return ok({ id, responsible_user_id: anterior }, { requestId });

  if (novo !== null) {
    // Membro ATIVO desta organização (a da sessão, nunca do corpo), e que atende: o observador
    // não envia mensagem. A chave estrangeira composta da 1019 repete a régua da organização no banco.
    const { data: membro, error: membroError } = await db
      .from("user_organizations")
      .select("role")
      .eq("organization_id", auth.org.orgId)
      .eq("user_id", novo)
      .is("revoked_at", null)
      .maybeSingle();
    if (membroError)
      return fail("internal_error", "Não foi possível conferir o membro.", 500, { requestId });
    const papel = (membro as { role?: string } | null)?.role;
    if (!papel || papel === "viewer")
      return fail(
        "validation_failed",
        "Escolha um membro ativo da equipe que atende conversas.",
        422,
        { requestId },
      );
  }

  const { data, error } = await db
    .from("channel_sessions")
    .update({ responsible_user_id: novo })
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .is("archived_at", null)
    .select("id, responsible_user_id")
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível salvar o membro responsável.", 500, {
      requestId,
    });
  if (!data) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  void audit({
    action: "channel.responsible_changed",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { previous_responsible_user_id: anterior, responsible_user_id: novo },
  });
  return ok(data, { requestId });
}
