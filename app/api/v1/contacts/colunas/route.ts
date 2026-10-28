/**
 * GET    /api/v1/contacts/colunas — as colunas que ESTE usuário escolheu para a tela de Contatos.
 * PUT    /api/v1/contacts/colunas — grava a escolha (`{ colunas: string[] }`, até 12).
 * DELETE /api/v1/contacts/colunas — "Restaurar padrão": apaga a escolha.
 *
 * Mora em `user_preferences` (migration 0978), uma linha por organização + usuário + chave. A
 * sessão do usuário (RLS) é o cliente: a policy só deixa ler e gravar a PRÓPRIA linha, e
 * `organization_id`/`user_id` vêm da sessão, nunca do corpo. Apresentação pura: nada aqui decide
 * acesso, e um id de coluna desconhecido é descartado na leitura (`normalizarColunas`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHAVE_DA_PREFERENCIA,
  MAXIMO_DE_COLUNAS,
  colunaValida,
  ehPadrao,
  normalizarColunas,
} from "@/lib/contacts/colunas-da-lista";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z
  .object({
    colunas: z
      .array(z.string().max(80))
      .min(1)
      .max(MAXIMO_DE_COLUNAS)
      .refine((l) => l.every(colunaValida), { message: "Coluna desconhecida." }),
  })
  .strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const db = await createClient();
  const { data, error } = await db
    .from("user_preferences")
    .select("valor")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", authz.user.id)
    .eq("chave", CHAVE_DA_PREFERENCIA)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível ler as colunas.", 500, { requestId });
  const colunas = normalizarColunas((data?.valor as { colunas?: unknown } | undefined)?.colunas);
  const res = ok({ colunas, padrao: ehPadrao(colunas) }, { requestId });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function PUT(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Escolha de colunas inválida.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }
  const colunas = normalizarColunas(parsed.data.colunas);
  const db = await createClient();
  const { error } = await db.from("user_preferences").upsert(
    {
      organization_id: authz.org.orgId,
      user_id: authz.user.id,
      chave: CHAVE_DA_PREFERENCIA,
      valor: { colunas },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,user_id,chave" },
  );
  if (error) return fail("internal_error", "Não foi possível salvar as colunas.", 500, { requestId });
  void audit({
    action: "user_preferences.updated",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "user_preference",
    resourceId: null,
    requestId,
    metadata: { chave: CHAVE_DA_PREFERENCIA, colunas },
  });
  return ok({ colunas, padrao: ehPadrao(colunas) }, { requestId });
}

export async function DELETE(): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const db = await createClient();
  const { error } = await db
    .from("user_preferences")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", authz.user.id)
    .eq("chave", CHAVE_DA_PREFERENCIA);
  if (error) return fail("internal_error", "Não foi possível restaurar as colunas.", 500, { requestId });
  void audit({
    action: "user_preferences.updated",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "user_preference",
    resourceId: null,
    requestId,
    metadata: { chave: CHAVE_DA_PREFERENCIA, restaurado: true },
  });
  const colunas = normalizarColunas(undefined);
  return ok({ colunas, padrao: true }, { requestId });
}
