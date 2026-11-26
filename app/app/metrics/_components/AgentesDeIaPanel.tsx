"use client";

/**
 * Desempenho › Agentes de IA — as métricas técnicas do agente que moravam na
 * antiga tela "Uso e orçamento" (`/app/ai/usage`, hoje só um redirect).
 *
 * Decisão do dono do produto (25/11/2026): o cliente é cobrado em TOKENS, e o
 * consumo mora num lugar só, Configurações › Meu plano e consumo de IA. Aqui
 * fica o que mede o TRABALHO do agente (chamadas, turnos, cache, passagem para
 * uma pessoa, tempo de uma chamada), e NENHUM valor em dólar: o custo do
 * provedor é da plataforma, não da organização (painel do /admin).
 *
 * Mesma fonte de antes: `GET /api/v1/ai/usage` → `fn_uso_de_ia`
 * (`lib/ai/usage/aggregate.ts`), que exige `manager`. Quem monta esta aba já
 * a esconde abaixo de gerente, para a consulta não sair e voltar 403.
 *
 * Os filtros são próprios (agente, tipo de uso e datas), como eram na tela
 * antiga: a rota corta a janela em 90 dias, e o período do topo vai a 366 —
 * seguir o filtro global mostraria um período e mediria outro, calado.
 */
import { useSearchParams } from "next/navigation";

import { Skeleton } from "@/components/ui/skeleton";
import { useAiUsage, type AiUsageFilters } from "@/hooks/ai/useAiUsage";
import { UsageFilters, type UsageFiltersAgent } from "@/components/ai/UsageFilters";
import { UsageChart } from "@/components/ai/UsageChart";
import { useT } from "@/hooks/i18n/useT";

import { CartaoKpi } from "./graficos";

interface Props {
  agents: UsageFiltersAgent[];
  initial: {
    agent_id?: string;
    invocation_kind?: string;
    from?: string;
    to?: string;
  };
}

function Esqueletos() {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-8 w-32" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-card p-4">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="mt-4 h-[200px] w-full" />
          </div>
        ))}
      </div>
    </>
  );
}

export function AgentesDeIaPanel({ agents, initial }: Props) {
  const t = useT();
  const searchParams = useSearchParams();

  const filters: AiUsageFilters = {
    agent_id: searchParams.get("agent_id") ?? undefined,
    invocation_kind: searchParams.get("invocation_kind") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  };

  const q = useAiUsage(filters);
  // As opções de "Tipo de uso" vêm da mesma consulta SEM o filtro de tipo: o
  // `by_kind` da consulta filtrada só tem o tipo escolhido, e a lista encolheria
  // para ele. Sem filtro de tipo a chave é a mesma e o react-query não repete a ida.
  const semTipo = useAiUsage({ ...filters, invocation_kind: undefined });
  const kinds = Object.keys(semTipo.data?.by_kind ?? {});

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t(
          "Esta aba tem filtros próprios (agente, tipo de uso e datas): não segue período, funil nem atendente do topo. O consumo de tokens do plano fica em Meu plano e consumo de IA.",
        )}
      </p>
      <UsageFilters agents={agents} kinds={kinds} initial={initial} />

      {q.isLoading || !q.data ? (
        <Esqueletos />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/*
              Este card se chamava "Atendimentos com IA" e contava linhas de
              `llm_calls` — CHAMADAS ao modelo. Um turno do agente faz várias
              (ferramentas, classificadores), então o número inflava o volume de
              atendimento. Os turnos têm o card ao lado.
            */}
            <CartaoKpi
              titulo={t("Chamadas de IA")}
              valor={q.data.totals.invocations.toLocaleString("pt-BR")}
              detalhe={t("cada resposta do agente pode fazer várias")}
            />
            {/*
              Turno = um job distinto com chamada `agent_turn` ou `followup_turn`
              (o follow-up, migration 9097) que deu certo. `llm_calls.job_id`
              vira null quando a poda da fila apaga o job, então o turno antigo
              deixa de contar — o detalhe diz isso em vez de esconder. O custo
              médio por turno (em dólar) saiu da vista da organização.
            */}
            <CartaoKpi
              titulo={t("Turnos do agente")}
              valor={q.data.totals.agent_turns.toLocaleString("pt-BR")}
              detalhe={
                q.data.totals.agent_turns === 0
                  ? t("sem turnos no período")
                  : t("conta só os turnos que a fila ainda guarda (padrão: 90 dias)")
              }
            />
            <CartaoKpi
              titulo={t("Taxa de cache")}
              valor={`${(q.data.totals.cache_hit_rate * 100).toLocaleString("pt-BR", {
                maximumFractionDigits: 1,
              })}%`}
              detalhe={t("do texto enviado à IA veio do cache, que custa bem menos")}
            />
            <CartaoKpi
              titulo={t("Passaram para uma pessoa")}
              valor={`${(q.data.totals.handoff_rate * 100).toFixed(2)}%`}
              detalhe={t("quanto mais alto, mais a IA precisou de ajuda")}
              tom="alerta"
            />
            {/*
              "p95" quer dizer: em 95 das 100 chamadas o tempo foi ATÉ isso. É a
              medida honesta (a média esconde os casos ruins), mas o rótulo não
              pode ser a sigla. E é o tempo de UMA chamada ao modelo — um turno
              do agente encadeia várias, então isto não é o tempo que o cliente
              esperou pela resposta.
            */}
            <CartaoKpi
              titulo={t("Tempo de uma chamada à IA")}
              valor={`${(q.data.totals.p95_latency_ms / 1000).toLocaleString("pt-BR", {
                maximumFractionDigits: 1,
              })} s`}
              detalhe={`${t("a maioria responde em")} ${(
                q.data.totals.p50_latency_ms / 1000
              ).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s; ${t("este é o pior caso comum")}`}
              tom="info"
            />
          </div>

          <UsageChart payload={q.data} />
        </>
      )}
    </div>
  );
}
