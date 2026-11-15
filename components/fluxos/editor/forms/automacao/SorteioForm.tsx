"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import {
  IDS_DOS_RAMOS_DO_SORTEIO,
  MAX_RAMOS_DO_SORTEIO,
  MIN_RAMOS_DO_SORTEIO,
  ramosDoSorteioConfig,
  sorteioConfigSchema,
} from "@/lib/automacoes/schemas";

import type { ConfigOf } from "../shared";
import { Campo } from "./comum";

type Linha = { peso: string; nome: string };

/**
 * O bloco "Sorteio": de 2 a 10 saídas (A, B, C…), cada uma com o seu peso em
 * %. Os pesos somam 100; uma saída com 0% fica ligada no fluxo mas não recebe
 * ninguém (o ramo reservado). O texto fica NOS CAMPOS enquanto a pessoa
 * digita; o bloco só recebe a config que passou no schema. A forma antiga
 * (`percent_a`) abre aqui como duas saídas e é regravada na forma nova na
 * primeira edição.
 */
export function SorteioForm({
  config,
  onChange,
}: {
  config: ConfigOf<"random_split">;
  onChange: (c: ConfigOf<"random_split">) => void;
}) {
  const t = useT();
  const [linhas, setLinhas] = useState<Linha[]>(() =>
    ramosDoSorteioConfig(config).map((r) => ({ peso: String(r.peso), nome: r.nome ?? "" })),
  );
  const [erro, setErro] = useState<string | null>(null);

  const gravar = (novas: Linha[]) => {
    setLinhas(novas);
    const ramos = novas.map((l) => {
      const nome = l.nome.trim();
      return { peso: l.peso.trim() === "" ? NaN : Number(l.peso), ...(nome ? { nome } : {}) };
    });
    const r = sorteioConfigSchema.safeParse({ ramos });
    if (!r.success) {
      const pesosValidos = ramos.every((x) => Number.isInteger(x.peso) && x.peso >= 0 && x.peso <= 100);
      setErro(
        pesosValidos
          ? t("Os pesos das saídas precisam somar 100%.")
          : t("Cada peso é um número inteiro de 0 a 100."),
      );
      return;
    }
    setErro(null);
    onChange(r.data);
  };

  const soma = linhas.reduce((acc, l) => acc + (Number.isFinite(Number(l.peso)) ? Number(l.peso) : 0), 0);
  const muda = (i: number, p: Partial<Linha>) => gravar(linhas.map((l, j) => (j === i ? { ...l, ...p } : l)));

  return (
    <div className="space-y-3" data-testid="sorteio-form">
      <Campo
        id="sorteio-saidas"
        rotulo={t("Saídas e pesos")}
        ajuda={t(
          "Cada contato é sorteado na hora, uma vez por passagem pelo bloco, conforme o peso de cada saída. Uma saída com 0% fica reservada e não recebe ninguém.",
        )}
      >
        <div className="space-y-2" id="sorteio-saidas">
          {linhas.map((l, i) => {
            const letra = IDS_DOS_RAMOS_DO_SORTEIO[i]!.toUpperCase();
            return (
              <div key={i} className="flex items-center gap-2" data-testid={`sorteio-saida-${letra}`}>
                <span className="w-5 text-sm font-medium text-text">{letra}</span>
                <Input
                  aria-label={`${t("Nome da saída")} ${letra}`}
                  placeholder={t("Nome (opcional)")}
                  className="flex-1"
                  maxLength={40}
                  value={l.nome}
                  onChange={(e) => muda(i, { nome: e.target.value })}
                  data-testid={`sorteio-nome-${letra}`}
                />
                <Input
                  aria-label={`${t("Peso da saída")} ${letra}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={1}
                  className="w-20"
                  value={l.peso}
                  onChange={(e) => muda(i, { peso: e.target.value })}
                  data-testid={`sorteio-peso-${letra}`}
                />
                <span className="text-sm text-text-muted">%</span>
                {linhas.length > MIN_RAMOS_DO_SORTEIO && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => gravar(linhas.filter((_, j) => j !== i))}
                    aria-label={`${t("Remover a saída")} ${letra}`}
                    data-testid={`sorteio-remover-${letra}`}
                  >
                    ×
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Campo>
      {linhas.length < MAX_RAMOS_DO_SORTEIO && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => gravar([...linhas, { peso: "0", nome: "" }])}
          data-testid="sorteio-adicionar"
        >
          {t("Adicionar saída")}
        </Button>
      )}
      <p className="text-sm text-text-muted" data-testid="sorteio-resumo">
        {t("Soma dos pesos:")} {soma}%
      </p>
      {erro && (
        <p role="alert" className="text-xs text-error-fg" data-testid="sorteio-erro">
          {erro}
        </p>
      )}
    </div>
  );
}
