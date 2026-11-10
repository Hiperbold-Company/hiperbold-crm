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
import { converterRegra, type RegraAntiga } from "@/lib/automacoes/converter-regra";
import { ultimaExecucaoPorPonteiro, type PonteiroDaLista, type RegraDaLista } from "@/lib/automacoes/lista-unica";
import { camposDeDataDoNegocio } from "@/lib/leads/campos-do-funil";

import { AutomacoesList } from "./_components/AutomacoesList";

export const dynamic = "force-dynamic";

const COLUNAS = "id, name, status, active_version_id, handoff_policy, updated_at";
const COLUNAS_DOS_FOLLOWUPS = "id, name, status, surface, updated_at";
const COLUNAS_DAS_REGRAS =
  "id, name, is_active, last_run_at, updated_at, migrated_to_pointer_id, trigger_event, trigger_config, conditions, actions";
/** O mesmo teto da tela antiga de regras e da lista de fluxos: a lista não pagina, mas não lê sem fim. */
const LIMITE_POR_TIPO = 500;

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
  const org = activeOrg.orgId;
  // Lote 5 — tela única: as três fontes, sempre filtrando a organização ativa. Quem chega aqui é
  // gerente ou acima, o mesmo papel que a tela de regras e a edição de follow-ups exigem.
  const [{ data }, { data: followups }, { data: regras }, { data: funis }, { data: etapas }] = await Promise.all([
    supabase
      .from("followup_flow_pointers")
      .select(COLUNAS)
      .eq("organization_id", org)
      .eq("surface", "automacao")
      .order("updated_at", { ascending: false })
      .limit(LIMITE_POR_TIPO),
    supabase
      .from("followup_flow_pointers")
      .select(COLUNAS_DOS_FOLLOWUPS)
      .eq("organization_id", org)
      .not("surface", "in", "(atendimento,automacao)")
      .order("updated_at", { ascending: false })
      .limit(LIMITE_POR_TIPO),
    supabase
      .from("automation_rules")
      .select(COLUNAS_DAS_REGRAS)
      .eq("organization_id", org)
      .order("updated_at", { ascending: false })
      .limit(LIMITE_POR_TIPO),
    supabase.from("crm_pipelines").select("id, name, settings").eq("organization_id", org),
    supabase.from("crm_stages").select("id, name, pipeline_id, is_archived, position").eq("organization_id", org).order("position"),
  ]);
  const ids = [...(data ?? []), ...(followups ?? [])].map((p) => p.id as string);
  const { data: execucoes } = ids.length
    ? await supabase
        .from("followup_enrollments")
        .select("pointer_id, started_at")
        .eq("organization_id", org)
        .in("pointer_id", ids)
        .order("started_at", { ascending: false })
        .limit(2000)
    : { data: [] };
  const regrasDaLista: RegraDaLista[] = (regras ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    is_active: r.is_active as boolean,
    last_run_at: (r.last_run_at as string | null) ?? null,
    updated_at: r.updated_at as string,
    migrated_to_pointer_id: (r.migrated_to_pointer_id as string | null) ?? null,
    conversivel: converterRegra(r as unknown as RegraAntiga).conversivel,
  }));
  const nomeDoFunil = new Map((funis ?? []).map((f) => [f.id as string, f.name as string]));
  const etapasAtivas = (etapas ?? [])
    .filter((e) => !e.is_archived)
    .map((e) => ({ id: e.id as string, nome: `${nomeDoFunil.get(e.pipeline_id as string) ?? ""} › ${e.name as string}` }));
  const camposDeData = [
    ...new Map(
      (funis ?? []).flatMap((f) =>
        camposDeDataDoNegocio((f.settings as Record<string, unknown> | null) ?? null).map((c) => [c.key, { key: c.key, label: c.label }] as const),
      ),
    ).values(),
  ];

  // D-227: o teto de automações do plano bloqueia sempre; o botão diz o motivo antes de a pessoa tentar.
  const bloqueio = await bloqueioDoBotaoDeCriacao(createAdminClient(), activeOrg.orgId, "automacoes", user.idioma, logger);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Automações")}</h1>
        <p className="text-sm text-text-muted">
          {t(
            "Tudo o que trabalha sozinho num lugar só: automações, follow-ups e as regras antigas. Quando um lead chega ou muda de etapa, a automação cria negócio, põe tag, preenche campo, define responsável e cria tarefa.",
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
        followups={(followups ?? []) as unknown as PonteiroDaLista[]}
        regras={regrasDaLista}
        ultimasExecucoes={ultimaExecucaoPorPonteiro((execucoes ?? []) as { pointer_id: string; started_at: string | null }[])}
        etapas={etapasAtivas}
        camposDeData={camposDeData}
        motivoDoBloqueio={bloqueio.motivo}
      />
    </div>
  );
}
