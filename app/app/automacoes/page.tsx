import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { bloqueioDoBotaoDeCriacao } from "@/lib/billing/planos/limite-de-agentes-e-automacoes";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";

import { AutomacoesList } from "./_components/AutomacoesList";

export const dynamic = "force-dynamic";

const COLUNAS = "id, name, status, active_version_id, handoff_policy, updated_at";

/**
 * Automações do CRM (0986): fluxos da superfície `automacao`, com o mesmo motor
 * dos follow-ups. Mexem no CRM (negócio, tag, campo, responsável, tarefa)
 * quando um lead é criado, entra numa etapa ou quando alguém as inicia.
 */
export default async function AutomacoesPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const supabase = await createClient();
  const { data } = await supabase
    .from("followup_flow_pointers")
    .select(COLUNAS)
    .eq("organization_id", activeOrg.orgId)
    .eq("surface", "automacao")
    .order("updated_at", { ascending: false });

  // D-227: o teto de automações do plano bloqueia sempre; o botão diz o motivo antes de a pessoa tentar.
  const bloqueio = await bloqueioDoBotaoDeCriacao(createAdminClient(), activeOrg.orgId, "automacoes", user.idioma, logger);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Automações")}</h1>
        <p className="text-sm text-text-muted">
          {t(
            "Regras que mexem no CRM sozinhas: quando um lead chega ou muda de etapa, a automação cria negócio, põe tag, preenche campo, define responsável e cria tarefa.",
          )}
        </p>
        </div>
        {/* Porta da tela de chaves (lote 4): o bloco Requisição HTTP usa as chaves daqui. */}
        <Link href="/app/automacoes/chaves" className="text-sm font-medium text-accent underline-offset-4 hover:underline" data-testid="link-chaves-secretas">
          {t("Chaves secretas")}
        </Link>
      </header>
      <AutomacoesList
        initialData={(data ?? []) as unknown as FollowupFlowPointerRow[]}
        motivoDoBloqueio={bloqueio.motivo}
      />
    </div>
  );
}
