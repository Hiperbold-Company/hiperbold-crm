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

  // A regra (conexão viva desta organização; membro ATIVO dela e que atende, não observador) vale
  // na PRÓPRIA escrita: `fn_gravar_membro_da_conexao` (migration 1019) trava a conexão e a linha do
  // membro, então uma remoção concorrente não deixa vínculo com quem já saiu. A organização é a da
  // sessão, nunca do corpo; a chave estrangeira composta repete a régua da organização no banco.
  const db = createAdminClient();
  const { data: rpcData, error } = await db.rpc("fn_gravar_membro_da_conexao", {
    p_org: auth.org.orgId,
    p_canal: id,
    p_user: novo,
  });
  if (error)
    return fail("internal_error", "Não foi possível salvar o membro responsável.", 500, {
      requestId,
    });
  const resultado = (rpcData ?? {}) as {
    resultado?: string;
    anterior?: string | null;
    atual?: string | null;
  };
  if (resultado.resultado === "canal_nao_encontrado")
    return fail("not_found", "Canal não encontrado.", 404, { requestId });
  if (resultado.resultado === "membro_invalido")
    return fail(
      "validation_failed",
      "Escolha um membro ativo da equipe que atende conversas.",
      422,
      { requestId },
    );
  const anterior = resultado.anterior ?? null;
  if (resultado.resultado === "sem_mudanca")
    return ok({ id, responsible_user_id: anterior }, { requestId });
  if (resultado.resultado !== "gravado")
    return fail("internal_error", "Não foi possível salvar o membro responsável.", 500, {
      requestId,
    });

  void audit({
    action: "channel.responsible_changed",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { previous_responsible_user_id: anterior, responsible_user_id: novo },
  });
  return ok({ id, responsible_user_id: novo }, { requestId });
}
