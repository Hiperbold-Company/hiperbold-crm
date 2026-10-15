import "server-only";

/**
 * Marca a organização como concluída no onboarding: `onboarded_at`, evento `tenant.onboarded` e
 * auditoria. Idempotente: só a PRIMEIRA vez que `onboarded_at` sai de nulo grava evento e audit.
 *
 * Vem de `finishOnboarding` (botão da tela final do wizard antigo) e é reaproveitada pelo roteador do
 * caminho "paga primeiro", que conclui sozinho quando o pagamento é confirmado, sem tela "done".
 * Quem chama já resolveu usuário e organização de fonte confiável (sessão): nada vem do body.
 */
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDeConcluir = { ok: true; jaConcluida: boolean } | { ok: false; detalhe: string };

export async function concluirOnboarding(params: { orgId: string; userId: string }): Promise<ResultadoDeConcluir> {
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("organizations")
    .select("onboarded_at")
    .eq("id", params.orgId)
    .maybeSingle();

  if (existing?.onboarded_at) return { ok: true, jaConcluida: true };

  // `.select("id")` devolve as linhas que o UPDATE condicional REALMENTE mudou: duas chamadas concorrentes
  // (polling da tela de pagamento) passam pela leitura acima, mas só uma muda a linha. Só ela emite evento e audit.
  const { data: alteradas, error } = await admin
    .from("organizations")
    .update({ onboarded_at: new Date().toISOString() })
    .eq("id", params.orgId)
    .is("onboarded_at", null)
    .select("id");
  if (error) return { ok: false, detalhe: error.message };
  if (!alteradas || alteradas.length === 0) return { ok: true, jaConcluida: true };

  await admin.from("event_log").insert({
    organization_id: params.orgId,
    event_type: "tenant.onboarded",
    // NOT NULL sem default — ver `tests/unit/evento-de-publicacao-tem-dono.test.ts`.
    entity_kind: "organization",
    payload: { completed_by: params.userId },
  });

  await audit({
    action: "onboarding.completed",
    actorUserId: params.userId,
    organizationId: params.orgId,
  });
  await audit({
    action: "tenant.onboarded",
    actorUserId: params.userId,
    organizationId: params.orgId,
  });

  return { ok: true, jaConcluida: false };
}
