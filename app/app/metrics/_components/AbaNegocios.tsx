"use client";

/**
 * Aba NEGÓCIOS de Desempenho. Fonte: `GET /api/v1/metrics/negocios`
 * (`fn_desempenho_negocios`, 0981) e, para a tabela, `/negocios/lista`.
 *
 * O cartão escolhido decide o gráfico diário e a tabela. Dinheiro só na moeda
 * principal do recorte; o que está em outra moeda é contado à parte, nunca
 * somado.
 */
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useDesempenhoNegocios, useListaDeNegocios, type DesempenhoNegocios } from "@/hooks/metrics/useDesempenho";
import { Badge } from "@/components/ui/badge";
import { Paginacao } from "@/components/ui/paginacao";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TipoDaLista } from "@/lib/metrics/desempenho";

import {
  Alternador,
  BarrasHorizontais,
  BarrasPorDia,
  CartaoKpi,
  COR,
  Painel,
} from "./graficos";
import { CELULA_DE_NUMERO, dinheiro, PainelAtendentesComMaisVendas, PainelPercentualDeGanhos } from "./paineis-compartilhados";
import { PerdasPanel } from "./PerdasPanel";
import { PrevisaoPanel } from "./PrevisaoPanel";

/**
 * Célula que, no celular, vira "Rótulo valor" dentro do cartão — o mesmo
 * padrão de `CELULA_DE_NUMERO` (paineis-compartilhados.tsx): o cabeçalho some abaixo de `md` e o rótulo
 * vem do `data-rotulo` da própria célula. Só classes `max-md:`; no computador a
 * tabela não muda.
 */
const CELULA_ROTULADA = "max-md:p-0 max-md:before:mr-1 max-md:before:text-muted-foreground max-md:before:content-[attr(data-rotulo)]";

type Medida = "quantidade" | "valor";

export function AbaNegocios({
  query,
  janela,
  funilEscolhido,
  podeVerPerdas,
  perdasDaEmpresaToda,
  currentUserId,
}: {
  query: string;
  janela: { from: string; to: string };
  funilEscolhido: boolean;
  podeVerPerdas: boolean;
  perdasDaEmpresaToda: boolean;
  currentUserId: string;
}) {
  const t = useT();
  const [tipo, setTipo] = useState<TipoDaLista>("criados");
  const [medida, setMedida] = useState<Medida>("quantidade");
  const { data, isLoading, isError } = useDesempenhoNegocios(query);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (isError || !data) return <p className="text-sm text-destructive">{t("Erro ao carregar métricas.")}</p>;
  const d = data.data;
  const moeda = d.moeda;

  const cartoes: Array<{ tipo: TipoDaLista; titulo: string; tom: keyof typeof COR }> = [
    { tipo: "criados", titulo: t("Negócios criados"), tom: "primaria" },
    { tipo: "ganhos", titulo: t("Ganhos"), tom: "ganho" },
    { tipo: "perdidos", titulo: t("Perdidos"), tom: "perda" },
    { tipo: "em_aberto", titulo: t("Criados e ainda abertos"), tom: "alerta" },
    { tipo: "carteira", titulo: t("Carteira aberta (total)"), tom: "info" },
  ];
  const tipoDoGrafico = tipo === "carteira" ? "criados" : tipo;
  const chaveDoGrafico =
    medida === "quantidade" ? tipoDoGrafico : (`${tipoDoGrafico}_valor_cents` as const);
  const corDoGrafico = cartoes.find((c) => c.tipo === tipoDoGrafico)?.tom ?? "primaria";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" data-testid="desempenho-cartoes-negocios">
        {cartoes.map((c) => (
          <CartaoKpi
            key={c.tipo}
            titulo={c.titulo}
            tom={c.tom}
            ativo={tipo === c.tipo}
            onClick={() => setTipo(c.tipo)}
            testId={`cartao-${c.tipo}`}
            valor={d.cartoes[c.tipo].quantidade.toLocaleString()}
            detalhe={dinheiro(d.cartoes[c.tipo].valor_cents, moeda)}
          />
        ))}
      </div>
      {d.fora_da_moeda > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("Valores em")} {moeda}. {d.fora_da_moeda}{" "}
          {t("negócios em outra moeda contam na quantidade e ficam fora das somas.")}
        </p>
      ) : null}

      <Painel
        titulo={
          tipo === "carteira"
            ? t("Dados diários — criados (a carteira não tem série diária)")
            : `${t("Dados diários")} — ${cartoes.find((c) => c.tipo === tipo)?.titulo ?? ""}`
        }
        descricao={t("Clique num cartão acima para trocar a série.")}
        acoes={
          <Alternador<Medida>
            rotulo={t("Medida")}
            valor={medida}
            onChange={setMedida}
            opcoes={[
              { valor: "quantidade", rotulo: t("Quantidade") },
              { valor: "valor", rotulo: t("Valor") },
            ]}
          />
        }
      >
        <BarrasPorDia
          dados={d.diario}
          chave={chaveDoGrafico}
          cor={COR[corDoGrafico]}
          formatar={medida === "valor" ? (n) => dinheiro(n, moeda, true) : undefined}
        />
      </Painel>

      <div className="grid gap-4 lg:grid-cols-2">
        <EtapasOuFunis d={d} funilEscolhido={funilEscolhido} />
        <Movimentacoes d={d} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <PainelPercentualDeGanhos atendentes={d.atendentes} nomeDe={(a) => nomeDe(a, t, currentUserId)} />
        <PainelAtendentesComMaisVendas
          atendentes={d.atendentes}
          moeda={moeda}
          nomeDe={(a) => nomeDe(a, t, currentUserId)}
        />
      </div>

      <TabelaDeNegocios query={query} tipo={tipo} titulo={cartoes.find((c) => c.tipo === tipo)?.titulo ?? ""} />

      {podeVerPerdas ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {t("Perdas segue o período escolhido; funil e atendente não se aplicam a este relatório.")}
          </p>
          <PerdasPanel avisoDaEmpresaToda={perdasDaEmpresaToda} janela={janela} />
        </div>
      ) : null}
      <PrevisaoPanel />
    </div>
  );
}

function nomeDe(
  a: { user_id: string | null; name: string | null },
  t: (s: string) => string,
  currentUserId: string,
): string {
  if (!a.user_id) return t("Sem responsável");
  const base = a.name ?? `${t("Atendente")} ${a.user_id.slice(0, 8)}`;
  return a.user_id === currentUserId ? `${base} ${t("(você)")}` : base;
}

function EtapasOuFunis({ d, funilEscolhido }: { d: DesempenhoNegocios; funilEscolhido: boolean }) {
  const t = useT();
  const linhas = funilEscolhido
    ? d.etapas.map((e) => ({
        chave: e.stage_id,
        rotulo: e.nome,
        valor: e.quantidade,
        detalhe: dinheiro(e.valor_cents, d.moeda, true),
      }))
    : d.funis.map((f) => ({
        chave: f.pipeline_id,
        rotulo: f.nome,
        valor: f.quantidade,
        detalhe: dinheiro(f.valor_cents, d.moeda, true),
      }));
  return (
    <Painel
      titulo={funilEscolhido ? t("Negócios abertos por etapa") : t("Negócios abertos por funil")}
      descricao={
        funilEscolhido
          ? t("Quantos estão em cada etapa agora.")
          : t("Escolha um funil no filtro para ver as etapas.")
      }
    >
      {linhas.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhuma etapa configurada.")}</p>
      ) : (
        <div data-testid="desempenho-etapas">
          <BarrasHorizontais linhas={linhas} />
        </div>
      )}
    </Painel>
  );
}

function Movimentacoes({ d }: { d: DesempenhoNegocios }) {
  const t = useT();
  return (
    <Painel
      titulo={`${t("Movimentações de etapa")} · ${d.movimentacoes.total}`}
      descricao={t("Mudanças de etapa no período, por dia e pela etapa de destino.")}
    >
      <BarrasPorDia dados={d.diario} chave="movimentacoes" cor={COR.info} altura={140} />
      {d.movimentacoes.por_etapa.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhuma movimentação no período.")}</p>
      ) : (
        <BarrasHorizontais
          cor={COR.info}
          linhas={d.movimentacoes.por_etapa.slice(0, 12).map((e) => ({
            chave: e.stage_id,
            rotulo: `${e.nome} · ${e.funil}`,
            valor: e.quantidade,
          }))}
        />
      )}
    </Painel>
  );
}

function TabelaDeNegocios({ query, tipo, titulo }: { query: string; tipo: TipoDaLista; titulo: string }) {
  const t = useT();
  const [pagina, setPagina] = useState(1);
  const [chave, setChave] = useState(`${query}|${tipo}`);
  // Trocar filtro ou cartão volta para a primeira página.
  if (chave !== `${query}|${tipo}`) {
    setChave(`${query}|${tipo}`);
    setPagina(1);
  }
  const { data, isLoading, isError } = useListaDeNegocios(query, tipo, pagina);
  const lista = data?.data;
  const paginas = lista ? Math.max(1, Math.ceil(lista.total / lista.por_pagina)) : 1;

  return (
    <Painel
      titulo={`${t("Negócios")} — ${titulo}`}
      descricao={lista ? `${lista.total.toLocaleString()} ${lista.total === 1 ? t("negócio") : t("negócios")}` : undefined}
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : isError || !lista ? (
        <p className="text-sm text-destructive">{t("Erro ao carregar métricas.")}</p>
      ) : lista.negocios.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum negócio neste recorte.")}</p>
      ) : (
        <div className="overflow-x-auto" data-testid="desempenho-tabela-negocios">
          <Table className="max-md:block">
            <TableHeader className="max-md:hidden">
              <TableRow>
                <TableHead>{t("Negócio")}</TableHead>
                <TableHead>{t("Valor")}</TableHead>
                <TableHead>{t("Atendente")}</TableHead>
                <TableHead>{t("Etapa")}</TableHead>
                <TableHead className="text-right">{t("Dias em aberto")}</TableHead>
                <TableHead className="text-right">{t("Dias na etapa")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="max-md:block">
              {lista.negocios.map((n) => (
                <TableRow key={n.id} className="max-md:grid max-md:grid-cols-2 max-md:gap-x-3 max-md:gap-y-1 max-md:py-2">
                  <TableCell className="max-w-64 max-md:col-span-2 max-md:max-w-none max-md:min-w-0 max-md:p-0">
                    <a href={`/app/leads/${n.id}`} className="block truncate font-medium hover:underline">
                      {n.contato ?? n.titulo}
                    </a>
                    {n.contato ? <span className="block truncate text-xs text-muted-foreground">{n.titulo}</span> : null}
                    {n.tags.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {n.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-[10px]">
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell data-rotulo={t("Valor")} className={`tabular-nums ${CELULA_ROTULADA}`}>
                    {n.value_cents == null || !n.currency ? "—" : dinheiro(n.value_cents, n.currency)}
                  </TableCell>
                  <TableCell data-rotulo={t("Atendente")} className={`truncate max-md:min-w-0 ${CELULA_ROTULADA}`}>{n.owner_name ?? (n.owner_user_id ? n.owner_user_id.slice(0, 8) : t("Sem responsável"))}</TableCell>
                  <TableCell className="min-w-36 max-md:col-span-2 max-md:min-w-0 max-md:p-0">
                    <span className="block truncate text-sm">
                      {n.status === "won" ? t("Ganho") : n.status === "lost" ? t("Perdido") : (n.etapa ?? "—")}
                    </span>
                    {n.status === "open" && n.progresso != null ? (
                      <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${Math.round(n.progresso * 100)}%` }}
                        />
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell data-rotulo={t("Dias em aberto")} className={CELULA_DE_NUMERO}>
                    {n.dias_em_aberto}
                  </TableCell>
                  <TableCell data-rotulo={t("Dias na etapa")} className={CELULA_DE_NUMERO}>
                    {n.dias_na_etapa ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {lista && paginas > 1 ? (
        <Paginacao pagina={pagina} totalDePaginas={paginas} onIr={setPagina} />
      ) : null}
    </Painel>
  );
}
