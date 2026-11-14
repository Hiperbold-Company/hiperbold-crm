"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import {
  PERCENTUAL_MAXIMO_DO_SORTEIO,
  PERCENTUAL_MINIMO_DO_SORTEIO,
  sorteioConfigSchema,
} from "@/lib/automacoes/schemas";

import type { ConfigOf } from "../shared";
import { Campo } from "./comum";

/**
 * O bloco "Sorteio": quantos por cento dos contatos seguem pela saída A (de 1
 * a 99). A saída B recebe o resto. O texto fica NO CAMPO enquanto a pessoa
 * digita; o bloco só recebe o número que passou no schema.
 */
export function SorteioForm({
  config,
  onChange,
}: {
  config: ConfigOf<"random_split">;
  onChange: (c: ConfigOf<"random_split">) => void;
}) {
  const t = useT();
  const [texto, setTexto] = useState(String(config.percent_a));
  const [erro, setErro] = useState<string | null>(null);

  const gravar = (bruto: string) => {
    setTexto(bruto);
    const r = sorteioConfigSchema.safeParse({ percent_a: bruto.trim() === "" ? NaN : Number(bruto) });
    if (!r.success) {
      setErro(t("Informe um número inteiro de 1 a 99."));
      return;
    }
    setErro(null);
    onChange(r.data);
  };

  const a = Number(texto);
  const valido = erro === null && Number.isInteger(a);

  return (
    <div className="space-y-3" data-testid="sorteio-form">
      <Campo
        id="sorteio-percentual"
        rotulo={t("Percentual que segue pela saída A")}
        ajuda={t("A saída B recebe o restante. Cada contato é sorteado na hora, uma vez por passagem pelo bloco.")}
      >
        <div className="flex items-center gap-2">
          <Input
            id="sorteio-percentual"
            type="number"
            inputMode="numeric"
            min={PERCENTUAL_MINIMO_DO_SORTEIO}
            max={PERCENTUAL_MAXIMO_DO_SORTEIO}
            step={1}
            className="w-24"
            value={texto}
            onChange={(e) => gravar(e.target.value)}
            data-testid="sorteio-percentual"
          />
          <span className="text-sm text-text-muted">%</span>
        </div>
      </Campo>
      {valido && (
        <p className="text-sm text-text-muted" data-testid="sorteio-resumo">
          A ({a}%) · B ({100 - a}%)
        </p>
      )}
      {erro && (
        <p role="alert" className="text-xs text-error-fg" data-testid="sorteio-erro">
          {erro}
        </p>
      )}
    </div>
  );
}
