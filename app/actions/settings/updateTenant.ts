"use server";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { atualizarDadosDaEmpresa } from "@/lib/organizacao/configuracao";
import { tenantSchema, type TenantInput } from "@/lib/schemas/settings";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";

export type UpdateTenantResult =
  | { ok: true }
  | { ok: false; error: string; details?: unknown };

export async function updateTenant(input: TenantInput): Promise<UpdateTenantResult> {
  const parsed = tenantSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

/**
 * A ESCRITA EM `organizations` VAI PELO ADMIN CLIENT — e não é preguiça.
 *
 * A única policy de escrita da tabela é `orgs_write_platform_admin`, com
 * `USING (fn_is_platform_admin())`. Pelo client de sessão, o UPDATE de quem não
 * é super-admin de plataforma casa ZERO linhas — e o PostgREST devolve sucesso,
 * porque "nenhuma linha casou o filtro" não é erro. Resultado: a tela dizia
 * "salvo", nada era gravado, e recarregar mostrava o estado antigo.
 *
 * Medido em Postgres com o baseline aplicado (issue #144): sob `authenticated`
 * com o JWT de um manager, `update organizations` devolve 0 linhas; sob
 * postgres, 1. Ninguém tinha notado porque o dono do repo e o owner criado pelo
 * `bootstrap-owner.ts` SÃO platform_admin — quem tropeça é o segundo admin
 * convidado e qualquer manager.
 *
 * O gate continua sendo o de cima (papel resolvido de fonte confiável), e o
 * filtro por `organization_id` é explícito, como a doutrina exige de todo
 * handler que usa service role.
 */
  const supabase = createAdminClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  // O núcleo é o mesmo da rota `PATCH /api/v1/settings/organizacao` e das tools MCP
  // (`lib/organizacao/configuracao.ts`): país revisado, CNPJ único, `invalidarOrg`
  // (#3696), audit e evento moram lá. O portão acima é o desta porta.
  const gravado = await atualizarDadosDaEmpresa(supabase, activeOrg.orgId, parsed.data, {
    actorUserId: authUser.id,
    requestId,
    ip,
    userAgent,
  });
  if (!gravado.ok) {
    if (gravado.error === "cnpj_em_uso") {
      return { ok: false, error: "Este CNPJ já pertence a outra organização." };
    }
    return gravado;
  }

  revalidatePath("/app/settings/tenant");
  return { ok: true };
}
