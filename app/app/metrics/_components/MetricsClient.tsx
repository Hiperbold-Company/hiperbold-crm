"use client";

/**
 * Desempenho — a área de inteligência de dados do CRM.
 *
 * Um filtro global (período, funil, atendente) na URL vale para as abas
 * Negócios, Origens e Atendimento. Atrito fica numa aba própria e NÃO segue o
 * filtro: é o número do sistema inteiro, e quebrá-lo por pessoa convida a
 * otimização local que degrada o todo (doutrina §3.6).
 *
 * O que a tela mostrava antes continua: funil por etapa (agora "abertos por
 * etapa/funil" na aba Negócios), Perdas e Previsão (Negócios), performance por
 * atendente (Atendimento) e Atrito.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type Aba,
  type FiltrosDaTela,
  filtrosParaUrl,
  janelaDosFiltros,
  lerFiltrosDaUrl,
  queryDaApi,
} from "@/lib/metrics/desempenho";

import { AbaAtendimento } from "./AbaAtendimento";
import { AbaNegocios } from "./AbaNegocios";
import { AbaOrigens } from "./AbaOrigens";
import { AtritoPanel } from "./AtritoPanel";
import { FiltrosDeDesempenho, type FunilDoFiltro } from "./FiltrosDeDesempenho";
import { CanaisPanel } from "./CanaisPanel";
import { MetaDoMesPanel, type EstadoDaMeta } from "./MetaDoMesPanel";
import { SeriePanel } from "./SeriePanel";
import { useMetasDoMes } from "@/hooks/metrics/useMetasDoMes";
import { janelaDoMes, mesLocal } from "@/lib/metas/periodo";

interface Props {
  canCompare: boolean;
  /** Permissões por perfil (`relatorios.perdas`). Ausente = o de antes (`canCompare`). */
  podeVerPerdas?: boolean;
  currentUserId: string;
  funis?: FunilDoFiltro[];
}

export function MetricsClient({ canCompare, podeVerPerdas = canCompare, currentUserId, funis = [] }: Props) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filtros = useMemo(() => lerFiltrosDaUrl(searchParams), [searchParams]);
  // O atendente comum não escolhe pessoa: a RLS já o escopa (ver FiltrosDeDesempenho).
  const efetivos: FiltrosDaTela = canCompare ? filtros : { ...filtros, atendente: null };
  // A janela é recalculada quando o filtro muda, não a cada render: a query
  // precisa ser estável para o cache não buscar de novo a todo instante.
  const chaveDosFiltros = filtrosParaUrl({ ...efetivos, aba: "negocios" });
  const { query, janela } = useMemo(() => {
    const { from, to } = janelaDosFiltros(efetivos);
    return { query: queryDaApi(efetivos), janela: { from: from.toISOString(), to: to.toISOString() } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveDosFiltros]);

  // A meta é MENSAL e a janela é o mês corrente de quem está olhando a tela
  // (o mês é o dele, não um instante UTC — ver `lib/metas/periodo.ts`). Fixada
  // uma vez por montagem; NÃO segue o filtro de período: o alvo é um só.
  const [janelaDaMeta] = useState(() => janelaDoMes(mesLocal()));
  const metasDoMes = useMetasDoMes(janelaDaMeta);
  const estadoDaMeta: EstadoDaMeta = metasDoMes.isLoading
    ? "carregando"
    : metasDoMes.isError || !metasDoMes.data
      ? "erro"
      : metasDoMes.data.data.motivo === "sem_meta"
        ? "vazio"
        : "ok";

  const mudar = (f: FiltrosDaTela) => router.replace(`${pathname}${filtrosParaUrl(f)}`, { scroll: false });

  return (
    <div className="flex flex-col gap-4">
      <FiltrosDeDesempenho
        filtros={efetivos}
        onChange={mudar}
        funis={funis}
        podeEscolherAtendente={canCompare}
        currentUserId={currentUserId}
      />

      <Tabs value={filtros.aba} onValueChange={(v) => mudar({ ...filtros, aba: v as Aba })}>
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="negocios">{t("Negócios")}</TabsTrigger>
          <TabsTrigger value="origens">{t("Origens")}</TabsTrigger>
          <TabsTrigger value="atendimento">{t("Atendimento")}</TabsTrigger>
          <TabsTrigger value="atrito">{t("Atrito")}</TabsTrigger>
        </TabsList>

        <TabsContent value="negocios" className="mt-4">
          {filtros.aba === "negocios" ? (
            <div className="flex flex-col gap-4">
              {/* A meta do mês (upstream #3025): o ALVO da empresa, acima do
                  funil; não segue o filtro de período nem de atendente. */}
              <MetaDoMesPanel
                estado={estadoDaMeta}
                periodo={metasDoMes.data?.data.periodo ?? null}
                metas={metasDoMes.data?.data.metas ?? []}
                podeConfigurar={canCompare}
                valores={metasDoMes.data?.data.valores_do_periodo ?? null}
              />
              <AbaNegocios
              query={query}
              janela={janela}
              funilEscolhido={!!efetivos.funil}
              podeVerPerdas={podeVerPerdas}
              perdasDaEmpresaToda={!canCompare}
              currentUserId={currentUserId}
              />
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="origens" className="mt-4">
          {filtros.aba === "origens" ? <AbaOrigens query={query} /> : null}
        </TabsContent>
        <TabsContent value="atendimento" className="mt-4">
          {filtros.aba === "atendimento" ? (
            <div className="flex flex-col gap-4">
              <AbaAtendimento
                query={query}
                janela={janela}
                atendente={efetivos.atendente}
                canCompare={canCompare}
                currentUserId={currentUserId}
              />
              {/* Relatório "Por canal" (upstream #2390), pelo atendente do filtro;
                  fora dele a RLS escopa. E a série no tempo (upstream). */}
              <CanaisPanel owner={efetivos.atendente} />
              <SeriePanel />
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="atrito" className="mt-4">
          {filtros.aba === "atrito" ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                {t("O atrito é do sistema inteiro: não segue período, funil nem atendente.")}
              </p>
              <AtritoPanel podeEditarRegua={canCompare} />
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
