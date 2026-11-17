"use client";

/**
 * O painel de indicadores do Início: um resumo de Atendimento, Negócios e Origens, com os mesmos
 * cartões e gráficos da tela Desempenho (mesmos hooks e primitivos, nenhuma rota nova). Cada seção
 * carrega e falha sozinha; o período vale para as três e o botão do fim de cada uma abre a tela
 * Desempenho já na aba certa e no mesmo período.
 */
import Link from "next/link";
import { useMemo, useState } from "react";

import { SeletorDePeriodo } from "@/app/app/metrics/_components/FiltrosDeDesempenho";
import { CartaoKpi } from "@/app/app/metrics/_components/graficos";
import {
  dinheiro,
  PainelAtendentesComMaisVendas,
  PainelAtendimentosPorAtendente,
  PainelPercentualDeGanhos,
  PainelQuandoOsClientesEscrevem,
  PainelRankingDeAtendimento,
} from "@/app/app/metrics/_components/paineis-compartilhados";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import {
  useDesempenhoAtendimento,
  useDesempenhoNegocios,
  useDesempenhoOrigens,
} from "@/hooks/metrics/useDesempenho";
import {
  type Aba,
  type FiltrosDaTela,
  filtrosParaUrl,
  formatarDuracao,
  queryDaApi,
} from "@/lib/metrics/desempenho";
import { formatarTaxa, resumoDeOrigens } from "@/lib/metrics/origens-rastreadas";
import { ArrowRight } from "@/lib/ui/icons";

/** O padrão da Desempenho: últimos 30 dias, sem funil nem atendente. */
const FILTROS_INICIAIS: FiltrosDaTela = { aba: "negocios", atalho: "30d", de: null, ate: null, funil: null, atendente: null };

/** Para onde o botão de cada seção leva: a aba certa da Desempenho, no período escolhido. */
export function hrefDaDesempenho(filtros: FiltrosDaTela, aba: Aba): string {
  return `/app/metrics${filtrosParaUrl({ ...filtros, aba })}`;
}

export function PainelDoInicio({ currentUserId }: { currentUserId: string }) {
  const [filtros, setFiltros] = useState<FiltrosDaTela>(FILTROS_INICIAIS);
  // A query tem instantes de `new Date()`: sem memo, cada render pediria de novo e o cache nunca assentaria.
  const chave = filtrosParaUrl(filtros);
  const query = useMemo(
    () => queryDaApi(filtros),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chave],
  );

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="inicio-painel">
      <div
        className="flex flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm sm:flex-row sm:flex-wrap sm:items-end"
        data-testid="inicio-painel-periodo"
      >
        <SeletorDePeriodo filtros={filtros} onChange={setFiltros} />
      </div>
      <SecaoAtendimento query={query} filtros={filtros} currentUserId={currentUserId} />
      <SecaoNegocios query={query} filtros={filtros} currentUserId={currentUserId} />
      <SecaoOrigens query={query} filtros={filtros} />
    </div>
  );
}

function Secao({
  id,
  titulo,
  estado,
  href,
  botao,
  children,
}: {
  id: string;
  titulo: string;
  estado: "carregando" | "erro" | "ok";
  href: string;
  botao: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <section aria-labelledby={`inicio-secao-${id}`} className="flex min-w-0 flex-col gap-4" data-testid={`inicio-secao-${id}`}>
      <h2 id={`inicio-secao-${id}`} className="text-lg font-semibold tracking-tight">
        {titulo}
      </h2>
      {estado === "carregando" ? <p className="text-sm text-muted-foreground">{t("Carregando…")}</p> : null}
      {estado === "erro" ? <p className="text-sm text-destructive">{t("Erro ao carregar métricas.")}</p> : null}
      {estado === "ok" ? children : null}
      <div>
        <Button asChild variant="outline" size="sm">
          <Link href={href} data-testid={`inicio-ver-tudo-${id}`}>
            {botao}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </section>
  );
}

function estadoDe(q: { isLoading: boolean; isError: boolean; data?: unknown }): "carregando" | "erro" | "ok" {
  if (q.isLoading) return "carregando";
  if (q.isError || !q.data) return "erro";
  return "ok";
}

function SecaoAtendimento({ query, filtros, currentUserId }: { query: string; filtros: FiltrosDaTela; currentUserId: string }) {
  const t = useT();
  const q = useDesempenhoAtendimento(query);
  const d = q.data?.data;
  const nomeDe = (a: { user_id: string | null; name: string | null; email?: string | null }) => {
    if (!a.user_id) return t("Sem responsável");
    const base = a.name ?? a.email ?? `${t("Atendente")} ${a.user_id.slice(0, 8)}`;
    return a.user_id === currentUserId ? `${base} ${t("(você)")}` : base;
  };
  return (
    <Secao
      id="atendimento"
      titulo={t("Atendimento")}
      estado={estadoDe(q)}
      href={hrefDaDesempenho(filtros, "atendimento")}
      botao={t("VER TUDO EM ATENDIMENTO")}
    >
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="inicio-cartoes-atendimento">
            <CartaoKpi titulo={t("Atendimentos")} valor={d.cartoes.atendimentos.toLocaleString()} />
            <CartaoKpi titulo={t("Finalizados")} tom="ganho" valor={d.cartoes.finalizados.toLocaleString()} />
            <CartaoKpi titulo={t("Em aberto")} tom="alerta" valor={d.cartoes.em_aberto.toLocaleString()} />
            <CartaoKpi
              titulo={t("Aguardando resposta")}
              tom="perda"
              valor={d.cartoes.aguardando.toLocaleString()}
              detalhe={t("cliente falou por último")}
            />
            <CartaoKpi titulo={t("1ª resposta (média)")} tom="info" valor={formatarDuracao(d.tempos.primeira_resposta_seg)} />
            <CartaoKpi
              titulo={t("Tempo de resposta (média)")}
              tom="info"
              valor={formatarDuracao(d.tempos.resposta_seg)}
              detalhe={`${d.tempos.respostas.toLocaleString()} ${t("respostas")}`}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-5">
            <PainelAtendimentosPorAtendente atendentes={d.atendentes} nomeDe={nomeDe} />
            <PainelRankingDeAtendimento atendentes={d.atendentes} nomeDe={nomeDe} />
          </div>
          <PainelQuandoOsClientesEscrevem d={d} />
        </>
      ) : null}
    </Secao>
  );
}

function SecaoNegocios({ query, filtros, currentUserId }: { query: string; filtros: FiltrosDaTela; currentUserId: string }) {
  const t = useT();
  const q = useDesempenhoNegocios(query);
  const d = q.data?.data;
  const nomeDe = (a: { user_id: string | null; name: string | null }) => {
    if (!a.user_id) return t("Sem responsável");
    const base = a.name ?? `${t("Atendente")} ${a.user_id.slice(0, 8)}`;
    return a.user_id === currentUserId ? `${base} ${t("(você)")}` : base;
  };
  return (
    <Secao
      id="negocios"
      titulo={t("Negócios")}
      estado={estadoDe(q)}
      href={hrefDaDesempenho(filtros, "negocios")}
      botao={t("VER TUDO EM NEGÓCIOS")}
    >
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="inicio-cartoes-negocios">
            <CartaoKpi
              titulo={t("Negócios criados")}
              valor={d.cartoes.criados.quantidade.toLocaleString()}
              detalhe={dinheiro(d.cartoes.criados.valor_cents, d.moeda)}
            />
            <CartaoKpi
              titulo={t("Ganhos")}
              tom="ganho"
              valor={d.cartoes.ganhos.quantidade.toLocaleString()}
              detalhe={dinheiro(d.cartoes.ganhos.valor_cents, d.moeda)}
            />
            <CartaoKpi
              titulo={t("Perdidos")}
              tom="perda"
              valor={d.cartoes.perdidos.quantidade.toLocaleString()}
              detalhe={dinheiro(d.cartoes.perdidos.valor_cents, d.moeda)}
            />
            <CartaoKpi
              titulo={t("Carteira aberta (total)")}
              tom="info"
              valor={d.cartoes.carteira.quantidade.toLocaleString()}
              detalhe={dinheiro(d.cartoes.carteira.valor_cents, d.moeda)}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-5">
            <PainelPercentualDeGanhos atendentes={d.atendentes} nomeDe={nomeDe} />
            <PainelAtendentesComMaisVendas atendentes={d.atendentes} moeda={d.moeda} nomeDe={nomeDe} />
          </div>
        </>
      ) : null}
    </Secao>
  );
}

function SecaoOrigens({ query, filtros }: { query: string; filtros: FiltrosDaTela }) {
  const t = useT();
  const q = useDesempenhoOrigens(query);
  const d = q.data?.data;
  const r = d ? resumoDeOrigens(d.por_source, d.total, d.cortado.source) : null;
  return (
    <Secao
      id="origens"
      titulo={t("Origens")}
      estado={estadoDe(q)}
      href={hrefDaDesempenho(filtros, "origens")}
      botao={t("VER TUDO EM ORIGENS")}
    >
      {r ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="inicio-cartoes-origens">
          <CartaoKpi
            titulo={t("Com origem rastreada")}
            tom="info"
            valor={r.comOrigem === null ? "—" : r.comOrigem.toLocaleString()}
          />
          <CartaoKpi
            titulo={t("Sem origem rastreada")}
            tom="alerta"
            valor={r.semOrigem === null ? "—" : r.semOrigem.toLocaleString()}
          />
          <CartaoKpi
            titulo={t("Ganhos de origem rastreada")}
            tom="ganho"
            valor={r.ganhosRastreados.toLocaleString()}
            detalhe={r.parcial ? t("Parcial: mais de 50 origens no período") : undefined}
          />
          <CartaoKpi
            titulo={t("Taxa de ganho de origem rastreada")}
            tom="ganho"
            valor={formatarTaxa(r.taxaDeGanhoRastreada)}
            detalhe={
              r.parcial
                ? t("Parcial: mais de 50 origens no período")
                : t("Ganhos ÷ criados com origem rastreada")
            }
          />
        </div>
      ) : null}
    </Secao>
  );
}
