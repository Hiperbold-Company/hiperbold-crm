"use client";

/**
 * Peças visuais de Desempenho. Só apresentam: toda conta chega pronta do
 * servidor. Cores vêm dos tokens de `app/globals.css` (nada de hex solto), para
 * seguir a marca da instalação e o tema escuro.
 */
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { cn } from "@/lib/utils";

export const COR = {
  primaria: "var(--color-accent)",
  ganho: "var(--color-success)",
  perda: "var(--color-error)",
  alerta: "var(--color-warning)",
  info: "var(--color-info)",
  neutra: "var(--color-neutral-400)",
} as const;

/** Paleta das fatias e séries por pessoa: ordem fixa, tokens da marca. */
export const PALETA = [
  "var(--color-accent)",
  "var(--color-info)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-accent-300)",
  "var(--color-error)",
  "var(--color-accent-800)",
  "var(--color-neutral-400)",
];

const ESTILO_DA_DICA = {
  border: "1px solid var(--color-border)",
  background: "var(--color-surface)",
  color: "var(--color-text)",
  borderRadius: 8,
  fontSize: 12,
};

export function diaCurto(dia: string, idioma: string): string {
  return new Date(`${dia}T00:00:00Z`).toLocaleDateString(idioma, {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });
}

export function CartaoKpi({
  titulo,
  valor,
  detalhe,
  tom = "primaria",
  ativo = false,
  onClick,
  testId,
}: {
  titulo: string;
  valor: ReactNode;
  detalhe?: ReactNode;
  tom?: keyof typeof COR;
  ativo?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  const conteudo = (
    <>
      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span aria-hidden className="size-2 rounded-full" style={{ background: COR[tom] }} />
        {titulo}
      </span>
      <span className="text-xl font-semibold tabular-nums">{valor}</span>
      {detalhe ? <span className="text-xs text-muted-foreground tabular-nums">{detalhe}</span> : null}
    </>
  );
  const classe = cn(
    "flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-4 text-left shadow-sm transition-colors",
    onClick && "cursor-pointer hover:border-primary/60",
    ativo && "border-primary ring-1 ring-primary",
  );
  return onClick ? (
    <button type="button" className={classe} onClick={onClick} aria-pressed={ativo} data-testid={testId}>
      {conteudo}
    </button>
  ) : (
    <div className={classe} data-testid={testId}>
      {conteudo}
    </div>
  );
}

export function BarrasPorDia<T extends { dia: string }>({
  dados,
  chave,
  cor = COR.primaria,
  formatar = (n) => n.toLocaleString(),
  altura = 220,
}: {
  dados: T[];
  chave: keyof T & string;
  cor?: string;
  formatar?: (n: number) => string;
  altura?: number;
}) {
  const idioma = useTagDeIdioma();
  return (
    <div style={{ height: altura }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={dados} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="dia"
            tickFormatter={(d: string) => diaCurto(d, idioma)}
            tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
            minTickGap={12}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
            tickFormatter={(n: number) => formatar(n)}
            width={64}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={ESTILO_DA_DICA}
            labelFormatter={(d) => diaCurto(String(d), idioma)}
            formatter={(v) => formatar(Number(v))}
            cursor={{ fill: "var(--color-surface-elevated)" }}
          />
          <Bar dataKey={chave as string} fill={cor} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LinhasPorDia<T extends { dia: string }>({
  dados,
  series,
  formatar,
  altura = 220,
}: {
  dados: T[];
  series: Array<{ chave: keyof T & string; nome: string; cor: string }>;
  formatar: (n: number) => string;
  altura?: number;
}) {
  const idioma = useTagDeIdioma();
  return (
    <div style={{ height: altura }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={dados} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="dia"
            tickFormatter={(d: string) => diaCurto(d, idioma)}
            tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
            minTickGap={12}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
            tickFormatter={(n: number) => formatar(n)}
            width={64}
          />
          <Tooltip
            contentStyle={ESTILO_DA_DICA}
            labelFormatter={(d) => diaCurto(String(d), idioma)}
            formatter={(v, nome) => [formatar(Number(v)), String(nome)]}
          />
          {series.map((s) => (
            <Line
              key={s.chave}
              type="monotone"
              dataKey={s.chave}
              name={s.nome}
              stroke={s.cor}
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Rosca({
  fatias,
  formatar = (n) => n.toLocaleString(),
}: {
  fatias: Array<{ nome: string; valor: number }>;
  formatar?: (n: number) => string;
}) {
  const total = fatias.reduce((s, f) => s + f.valor, 0);
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div className="size-40 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={fatias}
              dataKey="valor"
              nameKey="nome"
              innerRadius="60%"
              outerRadius="100%"
              paddingAngle={1}
              isAnimationActive={false}
            >
              {fatias.map((f, i) => (
                <Cell key={f.nome} fill={PALETA[i % PALETA.length]} stroke="var(--color-surface)" />
              ))}
            </Pie>
            <Tooltip contentStyle={ESTILO_DA_DICA} formatter={(v) => formatar(Number(v))} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex w-full min-w-0 flex-col gap-1.5 text-sm">
        {fatias.map((f, i) => (
          <li key={f.nome} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: PALETA[i % PALETA.length] }} />
            <span className="min-w-0 flex-1 truncate">{f.nome}</span>
            <span className="tabular-nums text-muted-foreground">
              {total > 0 ? `${Math.round((f.valor / total) * 100)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BarrasHorizontais({
  linhas,
  cor = COR.primaria,
}: {
  linhas: Array<{ chave: string; rotulo: string; valor: number; detalhe?: string }>;
  cor?: string;
}) {
  const maximo = Math.max(1, ...linhas.map((l) => l.valor));
  return (
    <div className="flex flex-col gap-2.5">
      {linhas.map((l) => (
        <div key={l.chave} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-sm sm:w-44" title={l.rotulo}>
            {l.rotulo}
          </span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${(l.valor / maximo) * 100}%`, background: cor }} />
          </div>
          <span className="w-10 shrink-0 text-right text-sm tabular-nums">{l.valor}</span>
          {l.detalhe ? (
            <span className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:inline">
              {l.detalhe}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** 7 linhas (domingo a sábado) × 24 horas; intensidade pela opacidade da cor primária. */
export function MapaDeCalor({ celulas }: { celulas: Array<{ dow: number; hora: number; quantidade: number }> }) {
  const idioma = useTagDeIdioma();
  const mapa = new Map(celulas.map((c) => [`${c.dow}-${c.hora}`, c.quantidade]));
  const maximo = Math.max(1, ...celulas.map((c) => c.quantidade));
  // 04/01/1970 foi domingo: base fixa para o nome curto do dia no idioma da pessoa.
  const nomeDoDia = (dow: number) =>
    new Date(Date.UTC(1970, 0, 4 + dow)).toLocaleDateString(idioma, { weekday: "short", timeZone: "UTC" });
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px] gap-0.5" style={{ gridTemplateColumns: "3rem repeat(24, minmax(0, 1fr))" }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-[10px] text-muted-foreground tabular-nums">
            {h}
          </span>
        ))}
        {Array.from({ length: 7 }, (_, dow) => (
          <div key={dow} className="contents">
            <span className="pr-1 text-right text-xs capitalize text-muted-foreground">{nomeDoDia(dow)}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const q = mapa.get(`${dow}-${h}`) ?? 0;
              return (
                <span
                  key={h}
                  title={`${nomeDoDia(dow)} ${h}h: ${q}`}
                  className="h-6 rounded-sm bg-muted"
                  style={q > 0 ? { background: COR.primaria, opacity: 0.15 + 0.85 * (q / maximo) } : undefined}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Painel({
  titulo,
  descricao,
  acoes,
  children,
  className,
}: {
  titulo: string;
  descricao?: ReactNode;
  acoes?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5", className)}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{titulo}</h2>
          {descricao ? <p className="text-xs text-muted-foreground">{descricao}</p> : null}
        </div>
        {acoes}
      </header>
      {children}
    </section>
  );
}

export function Alternador<T extends string>({
  valor,
  opcoes,
  onChange,
  rotulo,
}: {
  valor: T;
  opcoes: Array<{ valor: T; rotulo: string }>;
  onChange: (v: T) => void;
  rotulo: string;
}) {
  return (
    <div role="group" aria-label={rotulo} className="inline-flex rounded-lg border bg-muted p-0.5">
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          aria-pressed={valor === o.valor}
          onClick={() => onChange(o.valor)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            valor === o.valor ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}
