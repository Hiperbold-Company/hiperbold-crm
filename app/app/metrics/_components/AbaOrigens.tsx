"use client";

/**
 * Aba ORIGENS (rastreamento) de Desempenho. Fonte: `GET /api/v1/metrics/origens`
 * (`fn_desempenho_origens`, 0981): negócios CRIADOS no período por
 * `custom_fields.utm_source`, `utm_medium` e `utm_campaign`, com ganhos e taxa
 * de ganho (ganhos ÷ criados). Sem UTM = "(sem origem)".
 */
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useDesempenhoOrigens, type LinhaDeOrigem } from "@/hooks/metrics/useDesempenho";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatValorDoNegocio } from "@/lib/money";

import { Alternador, BarrasHorizontais, COR, CartaoKpi, Painel } from "./graficos";

type Dimensao = "source" | "medium" | "campaign";

export function AbaOrigens({ query }: { query: string }) {
  const t = useT();
  const [dim, setDim] = useState<Dimensao>("source");
  const { data, isLoading, isError } = useDesempenhoOrigens(query);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (isError || !data) return <p className="text-sm text-destructive">{t("Erro ao carregar métricas.")}</p>;
  const d = data.data;
  const linhas: LinhaDeOrigem[] = dim === "source" ? d.por_source : dim === "medium" ? d.por_medium : d.por_campaign;
  const rotulo = (chave: string | null) => chave ?? t("(sem origem)");
  const comOrigem = d.por_source.filter((l) => l.chave !== null).reduce((s, l) => s + l.total, 0);
  const ganhos = d.por_source.reduce((s, l) => s + l.ganhos, 0);
  const valor = (cents: number) =>
    /^[A-Z]{3}$/.test(d.moeda) ? formatValorDoNegocio(cents, d.moeda) : "—";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <CartaoKpi titulo={t("Negócios criados")} valor={d.total.toLocaleString()} />
        <CartaoKpi
          titulo={t("Com origem rastreada")}
          tom="info"
          valor={comOrigem.toLocaleString()}
          detalhe={d.total > 0 ? `${Math.round((comOrigem / d.total) * 100)}%` : "—"}
        />
        <CartaoKpi titulo={t("Ganhos")} tom="ganho" valor={ganhos.toLocaleString()} />
        <CartaoKpi
          titulo={t("Taxa de ganho")}
          tom="ganho"
          valor={d.total > 0 ? `${Math.round((ganhos / d.total) * 1000) / 10}%` : "—"}
        />
      </div>

      <Painel
        titulo={t("Negócios por origem")}
        descricao={t("Negócios criados no período, pela UTM gravada no negócio. Taxa de ganho = ganhos ÷ criados.")}
        acoes={
          <Alternador<Dimensao>
            rotulo={t("Dimensão")}
            valor={dim}
            onChange={setDim}
            opcoes={[
              { valor: "source", rotulo: t("Origem (utm_source)") },
              { valor: "medium", rotulo: t("Mídia (utm_medium)") },
              { valor: "campaign", rotulo: t("Campanha (utm_campaign)") },
            ]}
          />
        }
      >
        {linhas.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum negócio criado no período.")}</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <BarrasHorizontais
              cor={COR.primaria}
              linhas={linhas.slice(0, 15).map((l) => ({
                chave: l.chave ?? "__sem__",
                rotulo: rotulo(l.chave),
                valor: l.total,
                detalhe: `${l.ganhos} ${t("ganhos")}`,
              }))}
            />
            <div className="overflow-x-auto" data-testid="desempenho-tabela-origens">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Origem")}</TableHead>
                    <TableHead className="text-right">{t("Negócios")}</TableHead>
                    <TableHead className="text-right">{t("Ganhos")}</TableHead>
                    <TableHead className="text-right">{t("Perdidos")}</TableHead>
                    <TableHead className="text-right">{t("Taxa de ganho")}</TableHead>
                    <TableHead className="text-right">{t("Valor ganho")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {linhas.map((l) => (
                    <TableRow key={l.chave ?? "__sem__"}>
                      <TableCell className="max-w-48 truncate">{rotulo(l.chave)}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.total}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.ganhos}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.perdidos}</TableCell>
                      <TableCell className="text-right tabular-nums">{Math.round(l.taxa_de_ganho * 1000) / 10}%</TableCell>
                      <TableCell className="text-right tabular-nums">{valor(l.valor_ganho_cents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        {d.cortado[dim] ? (
          <p className="text-xs text-muted-foreground">
            {t("Mostrando as 50 origens com mais negócios.")}
          </p>
        ) : null}
      </Painel>
    </div>
  );
}
