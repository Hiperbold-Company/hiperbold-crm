"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import {
  PERIODOS_PREDEFINIDOS,
  ROTULO_DO_PERIODO,
  filtroDeDataAtivo,
  type FiltroDeData,
} from "@/lib/kanban/datas-do-lead";
import { cn } from "@/lib/utils";

/**
 * Um filtro de data da barra do quadro ("Criado em", "Última movimentação"):
 * atalhos (Hoje, Últimos 7 dias, Últimos 30 dias, Este mês) e período
 * personalizado (de/até). Escolher um atalho limpa o período e vice-versa — o
 * valor é UM dos dois, nunca os dois ao mesmo tempo, que é o que a URL também
 * serializa.
 *
 * Quem decide o que casa é `dentroDoFiltroDeData` (puro, no fuso da
 * organização); aqui só se escolhe.
 */
export function FiltroDeDataPopover({
  id,
  titulo,
  valor,
  onChange,
}: {
  id: string;
  titulo: string;
  valor: FiltroDeData | undefined;
  onChange: (next: FiltroDeData | undefined) => void;
}) {
  const t = useT();
  const ativo = filtroDeDataAtivo(valor);
  const resumo = valor?.predefinido
    ? t(ROTULO_DO_PERIODO[valor.predefinido])
    : valor?.de || valor?.ate
      ? `${valor.de ?? "…"} → ${valor.ate ?? "…"}`
      : t("Qualquer data");

  function personalizado(campo: "de" | "ate", v: string) {
    const next: FiltroDeData = { de: valor?.de, ate: valor?.ate, [campo]: v || undefined };
    onChange(filtroDeDataAtivo(next) ? next : undefined);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-filtro-de-data={id}
          className={cn(ativo && "border-accent bg-accent/10")}
        >
          {titulo}: {resumo}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-3 p-3">
        <p className="text-xs font-medium">{titulo}</p>
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="justify-start"
            aria-pressed={!ativo}
            onClick={() => onChange(undefined)}
          >
            {t("Qualquer data")}
          </Button>
          {PERIODOS_PREDEFINIDOS.map((p) => (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              className={cn("justify-start", valor?.predefinido === p && "bg-accent/10 font-medium")}
              aria-pressed={valor?.predefinido === p}
              onClick={() => onChange({ predefinido: p })}
            >
              {t(ROTULO_DO_PERIODO[p])}
            </Button>
          ))}
        </div>
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs text-text-muted">{t("Período personalizado")}</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-de`} className="text-xs">
                {t("De")}
              </Label>
              <input
                id={`${id}-de`}
                type="date"
                value={valor?.predefinido ? "" : (valor?.de ?? "")}
                max={valor?.ate || undefined}
                onChange={(e) => personalizado("de", e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-transparent px-1.5 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-ate`} className="text-xs">
                {t("Até")}
              </Label>
              <input
                id={`${id}-ate`}
                type="date"
                value={valor?.predefinido ? "" : (valor?.ate ?? "")}
                min={valor?.de || undefined}
                onChange={(e) => personalizado("ate", e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-transparent px-1.5 text-xs"
              />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
