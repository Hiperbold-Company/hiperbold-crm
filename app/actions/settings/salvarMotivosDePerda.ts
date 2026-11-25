"use server";

/**
 * Configurações › Motivos de perda (migration 1021): SUBSTITUI a lista de motivos de perda da
 * ORGANIZAÇÃO — a mesma em todos os funis. Mesmo portão da configuração do funil
 * (`updatePipelineConfig`): administrar a empresa + segundo fator + sem modo suporte só leitura.
 * A organização vem da sessão; a gravação e o audit moram em `salvarMotivosDaOrganizacao`.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { salvarMotivosDaOrganizacao, type MotivoDePerdaGravado } from "@/lib/leads/motivos-da-organizacao";
import { createAdminClient } from "@/lib/supabase/admin";

export type SalvarMotivosDePerdaResult =
  | { ok: true; lista: MotivoDePerdaGravado[]; mudou: boolean }
  | { ok: false; error: string; details?: unknown };

export async function salvarMotivosDePerda(lista: unknown): Promise<SalvarMotivosDePerdaResult> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const hdrs = await headers();
  const r = await salvarMotivosDaOrganizacao(createAdminClient(), {
    organizationId: activeOrg.orgId,
    lista,
    autor: { actorUserId: authUser.id },
    requestId: hdrs.get("x-request-id"),
  });
  if (!r.ok) return { ok: false, error: r.erro, details: r.detalhe };

  revalidatePath("/app/settings/motivos-de-perda");
  return { ok: true, lista: r.lista, mudou: r.mudou };
}
