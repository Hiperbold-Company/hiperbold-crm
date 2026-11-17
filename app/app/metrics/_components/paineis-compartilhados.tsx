"use client";

/**
 * Painéis que a tela Desempenho (abas Atendimento e Negócios) e o painel do Início
 * (`app/app/inicio`) mostram do mesmo jeito. Moram aqui para a conta e o desenho serem UM só:
 * quem muda o ranking muda nos dois lugares. Só apresentam; toda conta vem pronta do servidor.
 */
import { useT } from "@/hooks/i18n/useT";
import type { DesempenhoAtendimento, DesempenhoNegocios } from "@/hooks/metrics/useDesempenho";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatarDuracao } from "@/lib/metrics/desempenho";
import { formatValorDoNegocio } from "@/lib/money";

import { MapaDeCalor, Painel, Rosca } from "./graficos";

/**
 * Célula de número que, no celular, vira "Rótulo valor" dentro do cartão
 * (upstream, ADR-0006 F4): o cabeçalho some abaixo de `md` e o rótulo vem do
 * `data-rotulo` da própria célula. Só classes `max-md:`.
 */
export const CELULA_DE_NUMERO =
  "text-right tabular-nums max-md:p-0 max-md:text-left max-md:before:mr-1 max-md:before:text-muted-foreground max-md:before:content-[attr(data-rotulo)]";

export function dinheiro(cents: number, moeda: string, semCentavos = false): string {
  if (!/^[A-Z]{3}$/.test(moeda)) return "—";
  return formatValorDoNegocio(cents, moeda, { semCentavos });
}

type Atendimento = DesempenhoAtendimento["atendentes"][number];
type Venda = DesempenhoNegocios["atendentes"][number];

export function PainelQuandoOsClientesEscrevem({ d }: { d: DesempenhoAtendimento }) {
  const t = useT();
  return (
    <Painel
      titulo={t("Quando os clientes escrevem")}
      descricao={`${t("Mensagens recebidas por dia da semana e hora, no fuso da organização")} (${d.fuso}).`}
    >
      <MapaDeCalor celulas={d.mapa_de_calor} />
    </Painel>
  );
}

export function PainelAtendimentosPorAtendente({
  atendentes,
  nomeDe,
}: {
  atendentes: Atendimento[];
  nomeDe: (a: Atendimento) => string;
}) {
  const t = useT();
  return (
    <Painel className="lg:col-span-2" titulo={t("Atendimentos por atendente")}>
      {atendentes.some((a) => a.atendimentos > 0) ? (
        <Rosca
          fatias={atendentes.filter((a) => a.atendimentos > 0).map((a) => ({ nome: nomeDe(a), valor: a.atendimentos }))}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("Nenhum atendimento no período.")}</p>
      )}
    </Painel>
  );
}

export function PainelRankingDeAtendimento({
  atendentes,
  nomeDe,
}: {
  atendentes: Atendimento[];
  nomeDe: (a: Atendimento) => string;
}) {
  const t = useT();
  return (
    <Painel
      className="lg:col-span-3"
      titulo={t("Ranking de atendimento")}
      descricao={t("Atendimentos pelo responsável atual da conversa; tempos por quem respondeu.")}
    >
      {atendentes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum atendimento no período.")}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table className="max-md:block">
            <TableHeader className="max-md:hidden">
              <TableRow>
                <TableHead>{t("Atendente")}</TableHead>
                <TableHead className="text-right">{t("Atendimentos")}</TableHead>
                <TableHead className="text-right">{t("Finalizados")}</TableHead>
                <TableHead className="text-right">{t("Em aberto")}</TableHead>
                <TableHead className="text-right">{t("1ª resposta")}</TableHead>
                <TableHead className="text-right">{t("Resposta")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="max-md:block">
              {atendentes.map((a) => (
                <TableRow key={a.user_id ?? "sem"} className="max-md:grid max-md:grid-cols-2 max-md:gap-x-3 max-md:py-2">
                  <TableCell className="font-medium max-md:col-span-2 max-md:p-0">{nomeDe(a)}</TableCell>
                  <TableCell data-rotulo={t("Atendimentos")} className={CELULA_DE_NUMERO}>{a.atendimentos}</TableCell>
                  <TableCell data-rotulo={t("Finalizados")} className={CELULA_DE_NUMERO}>{a.finalizados}</TableCell>
                  <TableCell data-rotulo={t("Em aberto")} className={CELULA_DE_NUMERO}>{a.em_aberto}</TableCell>
                  <TableCell data-rotulo={t("1ª resposta")} className={CELULA_DE_NUMERO}>{formatarDuracao(a.primeira_resposta_seg)}</TableCell>
                  <TableCell data-rotulo={t("Resposta")} className={CELULA_DE_NUMERO}>{formatarDuracao(a.resposta_seg)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Painel>
  );
}

export function PainelPercentualDeGanhos({
  atendentes,
  nomeDe,
}: {
  atendentes: Venda[];
  nomeDe: (a: Venda) => string;
}) {
  const t = useT();
  return (
    <Painel
      className="lg:col-span-2"
      titulo={t("Percentual de ganhos por atendente")}
      descricao={t("Quantidade de negócios ganhos no período.")}
    >
      {atendentes.some((a) => a.ganhos > 0) ? (
        <Rosca fatias={atendentes.filter((a) => a.ganhos > 0).map((a) => ({ nome: nomeDe(a), valor: a.ganhos }))} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("Nenhum negócio ganho no período.")}</p>
      )}
    </Painel>
  );
}

export function PainelAtendentesComMaisVendas({
  atendentes,
  moeda,
  nomeDe,
}: {
  atendentes: Venda[];
  moeda: string;
  nomeDe: (a: Venda) => string;
}) {
  const t = useT();
  return (
    <Painel className="lg:col-span-3" titulo={t("Atendentes com mais vendas")}>
      {atendentes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Sem negócios no período.")}</p>
      ) : (
        <Table className="max-md:block">
          <TableHeader className="max-md:hidden">
            <TableRow>
              <TableHead>{t("Atendente")}</TableHead>
              <TableHead className="text-right">{t("Criados")}</TableHead>
              <TableHead className="text-right">{t("Ganhos")}</TableHead>
              <TableHead className="text-right">{t("Ticket médio")}</TableHead>
              <TableHead className="text-right">{t("Total")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="max-md:block">
            {atendentes.map((a) => (
              <TableRow key={a.user_id ?? "sem"} className="max-md:grid max-md:grid-cols-2 max-md:gap-x-3 max-md:py-2">
                <TableCell className="font-medium max-md:col-span-2 max-md:p-0">{nomeDe(a)}</TableCell>
                <TableCell data-rotulo={t("Criados")} className={CELULA_DE_NUMERO}>
                  {a.criados}
                </TableCell>
                <TableCell data-rotulo={t("Ganhos")} className={CELULA_DE_NUMERO}>
                  {a.ganhos}
                </TableCell>
                <TableCell data-rotulo={t("Ticket médio")} className={CELULA_DE_NUMERO}>
                  {a.ticket_medio_cents == null ? "—" : dinheiro(a.ticket_medio_cents, moeda)}
                </TableCell>
                <TableCell data-rotulo={t("Total")} className={CELULA_DE_NUMERO}>
                  {dinheiro(a.valor_ganho_cents, moeda)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Painel>
  );
}
