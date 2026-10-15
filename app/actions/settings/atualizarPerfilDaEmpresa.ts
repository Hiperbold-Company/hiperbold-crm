"use server";

import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { portaoDeAdminDaOrganizacao } from "@/lib/auth/portao-de-escrita";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { perfilDaEmpresaSchema, type PerfilDaEmpresaInput } from "@/lib/schemas/perfil-da-empresa";

export type AtualizarPerfilDaEmpresaResult = { ok: true } | { ok: false; error: string };

/**
 * Grava "o que a empresa faz" no MESMO lugar do onboarding: `organizations.onboarding_state.welcome.o_que_faz`
 * (o que `createDefaultAgent` e `montarQuadro` leem). Os demais campos de `welcome` (aceite dos Termos,
 * nome, fuso) são preservados como estão — esta tela só troca o ramo, e nunca fabrica um aceite de Termos
 * que a pessoa não deu: se `welcome` ainda não existe, nasce só com `o_que_faz`.
 *
 * Escrita pelo admin client pelo mesmo motivo de `updateTenant` (a policy de escrita de `organizations`
 * é só do admin da plataforma), com o portão comum de administrador + MFA e `organization_id` da sessão.
 */
export async function atualizarPerfilDaEmpresa(input: PerfilDaEmpresaInput): Promise<AtualizarPerfilDaEmpresaResult> {
  const parsed = perfilDaEmpresaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  const portao = await portaoDeAdminDaOrganizacao(authUser, activeOrg);
  if (!portao.ok) return { ok: false, error: portao.erro };

  const supabase = createAdminClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  const { data: atual, error: erroDeLeitura } = await supabase
    .from("organizations")
    .select("onboarding_state")
    .eq("id", activeOrg.orgId)
    .maybeSingle<{ onboarding_state: Record<string, unknown> | null }>();
  if (erroDeLeitura || !atual) return { ok: false, error: "internal_error" };

  const estado = atual.onboarding_state ?? {};
  const welcome = (estado.welcome ?? {}) as Record<string, unknown>;
  const { error } = await supabase
    .from("organizations")
    .update({ onboarding_state: { ...estado, welcome: { ...welcome, o_que_faz: parsed.data.o_que_faz } } })
    .eq("id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error" };

  await audit({
    action: "org.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    ip,
    userAgent,
    // O texto livre NÃO entra no audit (append-only, retenção de 5 anos): só o nome do campo.
    metadata: { fields_changed: ["o_que_faz"] },
  });

  revalidatePath("/app/settings/tenant");
  revalidatePath("/app/inicio");
  return { ok: true };
}
