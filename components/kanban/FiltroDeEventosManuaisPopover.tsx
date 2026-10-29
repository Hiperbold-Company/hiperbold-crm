"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import type { LeadFilters, OperadorDeEventosManuais } from "@/lib/kanban/filters";
import { cn } from "@/lib/utils";

const OPERADORES_DE_EVENTOS: Array<{
  value: OperadorDeEventosManuais;
  label: string;
  simbolo: string;
}> = [
  { value: "gt", label: "maior que", simbolo: ">" },
  { value: "eq", label: "igual a", simbolo: "=" },
  { value: "lt", label: "menor que", simbolo: "<" },
];

/**
 * "Eventos manuais" da barra do quadro: um botão, no padrão dos outros filtros,
 * que abre a comparação (maior que / igual a / menor que) e o número inteiro ≥ 0.
 *
 * O número tem estado próprio porque o campo pode estar vazio no meio da
 * digitação; só um inteiro válido chega ao filtro (e à URL). Sem operador, o
 * filtro sai.
 */
export function FiltroDeEventosManuaisPopover({
  valor,
  onChange,
}: {
  valor: LeadFilters["manualEvents"];
  onChange: (proximo: LeadFilters["manualEvents"]) => void;
}) {
  const t = useT();
  const [numero, setNumero] = useState(valor ? String(valor.n) : "");
  const [operador, setOperador] = useState<OperadorDeEventosManuais | "">(valor?.op ?? "");

  // A URL manda: "Limpar filtros" e voltar/avançar no navegador refletem aqui.
  // Ajuste durante a renderização (não em efeito): só quando o valor da URL muda.
  const chave = valor ? `${valor.op}:${valor.n}` : "";
  const [chaveVista, setChaveVista] = useState(chave);
  if (chave !== chaveVista) {
    setChaveVista(chave);
    setOperador(valor?.op ?? "");
    setNumero(valor ? String(valor.n) : "");
  }

  const aplicar = (op: OperadorDeEventosManuais | "", texto: string) => {
    if (!op) {
      onChange(undefined);
      return;
    }
    if (!/^\d{1,6}$/.test(texto.trim())) return;
    onChange({ op, n: Number(texto.trim()) });
  };

  const escolherOperador = (op: OperadorDeEventosManuais) => {
    setOperador(op);
    const texto = numero.trim() === "" ? "0" : numero;
    if (numero.trim() === "") setNumero("0");
    aplicar(op, texto);
  };

  const limpar = () => {
    setOperador("");
    setNumero("");
    aplicar("", "");
  };

  const simbolo = valor
    ? OPERADORES_DE_EVENTOS.find((o) => o.value === valor.op)?.simbolo
    : undefined;
  const rotulo = valor && simbolo
    ? `${t("Eventos manuais")} ${simbolo} ${valor.n}`
    : `${t("Eventos manuais")}: ${t("qualquer")}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-filtro-eventos-manuais
          className={cn(valor && "border-accent bg-accent/10")}
        >
          {rotulo}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 space-y-3 p-3">
        <p className="text-xs font-medium">{t("Eventos manuais")}</p>
        <div
          role="group"
          aria-label={t("Comparação de eventos manuais")}
          className="flex flex-col gap-1"
        >
          {OPERADORES_DE_EVENTOS.map((o) => (
            <Button
              key={o.value}
              variant="ghost"
              size="sm"
              className={cn("justify-start", operador === o.value && "bg-accent/10 font-medium")}
              aria-pressed={operador === o.value}
              onClick={() => escolherOperador(o.value)}
            >
              {t(o.label)}
            </Button>
          ))}
        </div>
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          aria-label={t("Quantidade de eventos manuais")}
          className="h-8 w-full px-2"
          value={numero}
          disabled={!operador}
          onChange={(e) => {
            setNumero(e.target.value);
            aplicar(operador, e.target.value);
          }}
        />
        <div className="border-t border-border pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            disabled={!operador && !valor}
            onClick={limpar}
          >
            {t("Limpar filtro")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
