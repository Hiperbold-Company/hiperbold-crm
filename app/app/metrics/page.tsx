import type { Metadata } from "next";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { papelPode } from "@/lib/permissoes/resolver";
import { createClient } from "@/lib/supabase/server";
import { Suspense } from "react";

import { redesignNaRequisicao } from "@/lib/redesign/chave";
import { marcaDasMetricas } from "@/lib/redesign/metricas";

import { MetricsClient } from "./_components/MetricsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Desempenho" };

export default async function MetricsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // spec 13 §6.1: agent vê as próprias (RLS); a comparação por atendente é manager+.
  const canCompare = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  // Permissões por perfil: o painel de Perdas segue `relatorios.perdas` (padrão
  // gerente+), o mesmo portão de `GET /api/v1/metrics/lost`.
  const podeVerPerdas = !!activeOrg && papelPode(activeOrg.role, "relatorios.perdas", activeOrg.permissoes);
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`), sem reler o `locale` cru.
  const idioma = user.idioma;
  // Funis do filtro global: leitura da sessão (a RLS decide), só os vivos.
  let funis: { id: string; name: string }[] = [];
  // Agentes do filtro da aba "Agentes de IA" (vinda de /app/ai/usage em 25/11/2026). Só lidos
  // para gerente para cima, o mesmo piso da aba e de `GET /api/v1/ai/usage`.
  let agentesDeIa: { id: string; name: string }[] = [];
  if (activeOrg) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", activeOrg.orgId)
      .eq("is_archived", false)
      .order("position");
    funis = data ?? [];
    if (canCompare) {
      const { data: agentes } = await supabase
        .from("ai_agents")
        .select("id, name")
        .eq("organization_id", activeOrg.orgId)
        .order("is_default", { ascending: false })
        .order("name", { ascending: true });
      agentesDeIa = (agentes ?? []).map((a: { id: string; name: string }) => ({ id: a.id, name: a.name }));
    }
  }
  const t = (texto: string) => traduzir(texto, idioma);
  const rd = marcaDasMetricas(await redesignNaRequisicao());

  return (
    <div className="flex h-full flex-col gap-4 sm:gap-6 md:p-6" data-rd-metricas={rd("tela")}>
      <header data-rd-metricas={rd("cabecalho")}>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Desempenho")}</h1>
        <p className="text-sm text-muted-foreground">
          {canCompare
            ? t("Negócios, origens e atendimento da equipe, com filtro de período, funil e atendente.")
            : t("Seus negócios, origens e atendimentos, com filtro de período e funil.")}
        </p>
      </header>

      <Suspense fallback={<p className="text-sm text-muted-foreground">{t("Carregando…")}</p>}>
        <MetricsClient
          canCompare={canCompare}
          podeVerPerdas={podeVerPerdas}
          currentUserId={user.id}
          funis={funis}
          agentesDeIa={agentesDeIa}
        />
      </Suspense>
    </div>
  );
}
