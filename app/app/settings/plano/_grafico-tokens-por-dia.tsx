"use client";

/**
 * O consumo de tokens do ciclo, dia a dia, em barras. Os dados são os MESMOS da
 * tabela "Por dia" do extrato (`extratoDoCiclo`, tokens ponderados, os que saem
 * da cota): o gráfico não lê nada a mais e não pode discordar da tabela.
 *
 * Veio da antiga tela "Uso e orçamento" (25/11/2026), que tinha a linha de
 * tokens por dia — mas de tokens CRUS de `llm_calls`, outro número. Aqui é o que
 * o cliente paga. Componente de cliente só porque a formatação do eixo é uma
 * função, e função não atravessa do servidor para o cliente.
 */
import { BarrasPorDia } from "@/app/app/metrics/_components/graficos";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

export function GraficoDeTokensPorDia({ dias }: { dias: Array<{ dia: string; tokensPonderados: number }> }) {
  const idioma = useTagDeIdioma();
  const formatar = (n: number) => n.toLocaleString(idioma, { notation: "compact", maximumFractionDigits: 1 });
  return <BarrasPorDia dados={dias} chave="tokensPonderados" formatar={formatar} altura={200} />;
}
