"use server";

/**
 * Grava as PERMISSÕES POR PERFIL da organização ativa (`settings.permissoes`).
 *
 * Portão: o mesmo de `atualizarInterfaceDaEmpresa` — sessão, acompanhamento
 * somente-leitura recusado, organização ativa de fonte confiável (cookie
 * validado contra as memberships, NUNCA argumento) e `portaoDeAdminDaOrganizacao`
 * (admin do tenant, ou admin da plataforma de escopo `full`, com MFA em dia).
 *
 * A escrita vai pelo ADMIN CLIENT (a única policy de escrita de `organizations`
 * é de admin de plataforma, issue #144) e só na chave `permissoes`
 * (`atualizarSettingDaOrganizacao`, D-132), filtrada pela organização da sessão.
 * Grava só o que difere do padrão; tudo no padrão = `null` (chave sem efeito).
 *
 * Audit `org.permissions_updated` com antes e depois (efetivos).
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { portaoDeAdminDaOrganizacao } from "@/lib/auth/portao-de-escrita";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { atualizarSettingDaOrganizacao } from "@/lib/organizations/atualizar-setting";
import {
  diferencasDoPadrao,
  permissoesEntradaSchema,
  resolverPermissoes,
  type PermissoesResolvidas,
} from "@/lib/permissoes/resolver";
import { createAdminClient } from "@/lib/supabase/admin";

export type ErroDePermissoes =
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "forbidden_tenant"
  | "forbidden_role"
  | "mfa_required"
  | "falha";

export type ResultadoDePermissoes =
  { ok: true; permissoes: PermissoesResolvidas } | { ok: false; error: ErroDePermissoes };

export async function salvarPermissoesPorPerfil(entrada: unknown): Promise<ResultadoDePermissoes> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const parsed = permissoesEntradaSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  const portao = await portaoDeAdminDaOrganizacao(authUser, activeOrg);
  if (!portao.ok) return { ok: false, error: portao.erro as ErroDePermissoes };

  const admin = createAdminClient();
  const { data: linha, error: erroDeLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (erroDeLeitura || !linha) {
    logger.error("[permissoes] leitura da organização falhou", {
      organization_id: activeOrg.orgId,
      message: erroDeLeitura?.message ?? "sem linha",
    });
    return { ok: false, error: "falha" };
  }
  const antes = resolverPermissoes((linha.settings as { permissoes?: unknown } | null)?.permissoes);
  const depois = parsed.data;
  const diferencas = diferencasDoPadrao(depois);
  const valor = Object.keys(diferencas).length > 0 ? diferencas : null;

  const gravado = await atualizarSettingDaOrganizacao(
    admin,
    activeOrg.orgId,
    ["permissoes"],
    valor,
  );
  if (!gravado.ok) {
    logger.error("[permissoes] gravação falhou", {
      organization_id: activeOrg.orgId,
      motivo: gravado.motivo,
    });
    return { ok: false, error: "falha" };
  }

  const hdrs = await headers();
  await audit({
    action: "org.permissions_updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent") ?? null,
    metadata: { antes, depois, gravado: valor },
  });

  // As permissões descem pelo layout de `/app` (AuthProvider): sem isto o menu e
  // os botões seguiriam com a escolha antiga até o próximo carregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true, permissoes: depois };
}
