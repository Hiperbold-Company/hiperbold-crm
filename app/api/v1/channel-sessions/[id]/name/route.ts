import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { CHAVES_DE_COR_DA_CONEXAO } from "@/lib/conexoes/cores";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * O nome interno e a cor da etiqueta (migration 1012) andam juntos: são a
 * etiqueta da conexão no Chat. Pelo menos um dos dois tem de vir; `label_color`
 * `null` tira a cor (volta à aparência de antes).
 */
const etiquetaSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80).optional(),
    label_color: z.enum(CHAVES_DE_COR_DA_CONEXAO).nullable().optional(),
  })
  .strict()
  .refine((v) => v.display_name !== undefined || v.label_color !== undefined);

/** Altera somente a etiqueta interna do canal; nada é enviado ao provedor. */
export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Administrador ou gerente: o mesmo piso da tela de Conexões e das rotas dos
  // cartões dela (conectar e remover em channels/instancia, official e
  // meta-social), decisão do dono do produto de 03/11/2026.
  const auth = await requireRole("manager", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", "Canal inválido.", 422, { requestId });

  const parsed = etiquetaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail(
      "validation_failed",
      "Informe um nome interno com até 80 caracteres ou uma cor da paleta.",
      422,
      { requestId },
    );

  const db = createAdminClient();
  const { data: before, error: readError } = await db
    .from("channel_sessions")
    .select("display_name, label_color")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (readError)
    return fail("internal_error", "Não foi possível ler o nome da conexão.", 500, { requestId });
  if (!before) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const mudancas: { display_name?: string; label_color?: string | null } = {};
  if (parsed.data.display_name !== undefined && parsed.data.display_name !== before.display_name)
    mudancas.display_name = parsed.data.display_name;
  if (
    parsed.data.label_color !== undefined &&
    parsed.data.label_color !== (before.label_color ?? null)
  )
    mudancas.label_color = parsed.data.label_color;

  if (Object.keys(mudancas).length === 0)
    return ok(
      { id, display_name: before.display_name, label_color: before.label_color ?? null },
      { requestId },
    );

  const { data, error } = await db
    .from("channel_sessions")
    .update(mudancas)
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .is("archived_at", null)
    .select("id, display_name, label_color")
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível salvar o nome da conexão.", 500, {
      requestId,
    });
  if (!data) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  if (mudancas.display_name !== undefined)
    void audit({
      action: "channel.renamed",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "channel_session",
      resourceId: id,
      requestId,
      metadata: { previous_display_name: before.display_name, display_name: mudancas.display_name },
    });
  if (mudancas.label_color !== undefined)
    void audit({
      action: "channel.label_color_changed",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "channel_session",
      resourceId: id,
      requestId,
      metadata: {
        previous_label_color: before.label_color ?? null,
        label_color: mudancas.label_color,
      },
    });
  return ok(data, { requestId });
}
