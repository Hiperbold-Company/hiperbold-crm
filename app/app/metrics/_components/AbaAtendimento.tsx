"use client";

/**
 * Aba ATENDIMENTO de Desempenho. Fonte: `GET /api/v1/metrics/atendimento`
 * (`fn_desempenho_atendimento`, 0982) e, na tabela de performance que a tela
 * já tinha, `GET /api/v1/metrics/attendants` com o mesmo período e atendente.
 *
 * Fora daqui por não serem medíveis no schema atual: duração do atendimento,
 * departamento e tempo para iniciar (ver cabeçalho da 0982).
 */
import { useT } from "@/hooks/i18n/useT";
import { useAttendantMetrics, type AttendantMetric } from "@/hooks/metrics/useAttendantMetrics";
import { useDesempenhoAtendimento } from "@/hooks/metrics/useDesempenho";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatarDuracao, variacaoPercentual } from "@/lib/metrics/desempenho";

import { BarrasPorDia, CartaoKpi, COR, LinhasPorDia, MapaDeCalor, Painel, Rosca } from "./graficos";

function nome(
  a: { user_id: string | null; name: string | null; email?: string | null },
  t: (s: string) => string,
  currentUserId: string,
): string {
  if (!a.user_id) return t("Sem responsável");
  const base = a.name ?? a.email ?? `${t("Atendente")} ${a.user_id.slice(0, 8)}`;
  return a.user_id === currentUserId ? `${base} ${t("(você)")}` : base;
}

export function AbaAtendimento({
  query,
  janela,
  atendente,
  canCompare,
  currentUserId,
}: {
  query: string;
  janela: { from: string; to: string };
  atendente: string | null;
  canCompare: boolean;
  currentUserId: string;
}) {
  const t = useT();
  const { data, isLoading, isError } = useDesempenhoAtendimento(query);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (isError || !data) return <p className="text-sm text-destructive">{t("Erro ao carregar métricas.")}</p>;
  const d = data.data;
  const variacao = variacaoPercentual(d.cartoes.atendimentos, d.cartoes.atendimentos_anterior);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="desempenho-cartoes-atendimento">
        <CartaoKpi
          titulo={t("Atendimentos")}
          valor={d.cartoes.atendimentos.toLocaleString()}
          detalhe={
            variacao == null
              ? t("sem base no período anterior")
              : `${variacao > 0 ? "+" : ""}${variacao}% ${t("vs. período anterior")}`
          }
        />
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Painel titulo={t("Atendimentos por dia")} descricao={t("Atendimentos iniciados em cada dia.")}>
          <BarrasPorDia dados={d.diario} chave="atendimentos" />
        </Painel>
        <Painel
          titulo={t("Tempo de resposta por dia")}
          descricao={t("Só respostas de pessoas; o robô não entra na conta.")}
        >
          <LinhasPorDia
            dados={d.diario}
            formatar={(n) => formatarDuracao(n)}
            series={[
              { chave: "primeira_resposta_seg", nome: t("1ª resposta"), cor: COR.primaria },
              { chave: "resposta_seg", nome: t("Resposta"), cor: COR.alerta },
            ]}
          />
        </Painel>
      </div>

      <Painel
        titulo={t("Quando os clientes escrevem")}
        descricao={`${t("Mensagens recebidas por dia da semana e hora, no fuso da organização")} (${d.fuso}).`}
      >
        <MapaDeCalor celulas={d.mapa_de_calor} />
      </Painel>

      <div className="grid gap-4 lg:grid-cols-5">
        <Painel className="lg:col-span-2" titulo={t("Atendimentos por atendente")}>
          {d.atendentes.some((a) => a.atendimentos > 0) ? (
            <Rosca
              fatias={d.atendentes
                .filter((a) => a.atendimentos > 0)
                .map((a) => ({ nome: nome(a, t, currentUserId), valor: a.atendimentos }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("Nenhum atendimento no período.")}</p>
          )}
        </Painel>
        <Painel
          className="lg:col-span-3"
          titulo={t("Ranking de atendimento")}
          descricao={t("Atendimentos pelo responsável atual da conversa; tempos por quem respondeu.")}
        >
          {d.atendentes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhum atendimento no período.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Atendente")}</TableHead>
                    <TableHead className="text-right">{t("Atendimentos")}</TableHead>
                    <TableHead className="text-right">{t("Finalizados")}</TableHead>
                    <TableHead className="text-right">{t("Em aberto")}</TableHead>
                    <TableHead className="text-right">{t("1ª resposta")}</TableHead>
                    <TableHead className="text-right">{t("Resposta")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.atendentes.map((a) => (
                    <TableRow key={a.user_id ?? "sem"}>
                      <TableCell className="font-medium">{nome(a, t, currentUserId)}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.atendimentos}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.finalizados}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.em_aberto}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatarDuracao(a.primeira_resposta_seg)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatarDuracao(a.resposta_seg)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Painel>
      </div>

      <PerformanceDosAtendentes
        janela={janela}
        atendente={atendente}
        canCompare={canCompare}
        currentUserId={currentUserId}
      />
    </div>
  );
}

/** A tabela que a tela já tinha (spec 13 §6), agora no período e atendente do filtro. */
function PerformanceDosAtendentes({
  janela,
  atendente,
  canCompare,
  currentUserId,
}: {
  janela: { from: string; to: string };
  atendente: string | null;
  canCompare: boolean;
  currentUserId: string;
}) {
  const t = useT();
  const { data, isLoading, isError } = useAttendantMetrics(atendente, janela);
  const linhas: AttendantMetric[] = data?.data.attendants ?? [];
  return (
    <Painel titulo={canCompare ? t("Performance por atendente") : t("Sua performance")}>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : isError ? (
        <p className="text-sm text-destructive">{t("Erro ao carregar métricas.")}</p>
      ) : linhas.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("Sem atividade no período (ganhos/perdidos, conversas ou respostas).")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Atendente")}</TableHead>
                <TableHead className="text-right">{t("Ganhos")}</TableHead>
                <TableHead className="text-right">{t("Perdidos")}</TableHead>
                <TableHead className="text-right">{t("Conversas")}</TableHead>
                <TableHead className="text-right">{t("1ª resposta (média)")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {linhas.map((a) => (
                <TableRow key={a.user_id}>
                  <TableCell className="font-medium">{nome(a, t, currentUserId)}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.won}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.lost}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.conversations_handled}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatarDuracao(a.avg_first_response_seconds)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Painel>
  );
}
