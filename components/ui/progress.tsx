/**
 * Barra de progresso do produto: `role="progressbar"` com os `aria-value*`
 * que o leitor de tela lê. `valor` acima do máximo ou abaixo de zero é
 * aparado — a barra nunca vaza da trilha. `tom` usa as cores de estado.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

const TOM = {
  marca: "bg-accent",
  sucesso: "bg-success",
  aviso: "bg-warning",
  erro: "bg-error",
} as const;

export interface ProgressProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "role"> {
  valor: number;
  maximo?: number;
  /** Nome da barra para o leitor de tela (ex.: "Uso do plano"). */
  rotulo: string;
  tom?: keyof typeof TOM;
  /** Classe da parte preenchida. */
  classeDoPreenchimento?: string;
}

export function Progress({
  valor,
  maximo = 100,
  rotulo,
  tom = "marca",
  className,
  classeDoPreenchimento,
  ...props
}: ProgressProps) {
  const max = maximo > 0 ? maximo : 100;
  const v = Number.isFinite(valor) ? Math.min(Math.max(valor, 0), max) : 0;
  const pct = (v / max) * 100;
  return (
    <div
      role="progressbar"
      aria-label={rotulo}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={v}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-surface-elevated", className)}
      {...props}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-300", TOM[tom], classeDoPreenchimento)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
