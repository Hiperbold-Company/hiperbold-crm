"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fieldOpConfigSchema, type FieldOp, type FieldOpConfig } from "@/lib/automacoes/schemas";
import { fraseDaOperacao, OPERACOES_DE_CAMPO } from "@/lib/automacoes/vocabulario";
import { useT } from "@/hooks/i18n/useT";
import { Plus, Trash } from "@/lib/ui/icons";

import { AJUDA_DAS_VARIAVEIS, Campo, Seletor, SeletorDeCampo } from "./comum";

/** Operação nova: definir um campo de texto do negócio (o caso mais comum). */
export function operacaoEmBranco(): FieldOp {
  return { target: { scope: "lead", key: "title" }, op: "set", value: "" };
}

/**
 * O bloco "Definir campo": grava valores em campos do negócio ou do contato.
 * O valor aceita variáveis; o servidor converte para o tipo do campo e, se não
 * servir, o contato sai pela saída "Erro" do bloco.
 */
export function FieldOpForm({
  config,
  onChange,
}: {
  config: FieldOpConfig;
  onChange: (config: FieldOpConfig) => void;
}) {
  const t = useT();
  const [rascunho, setRascunho] = useState<FieldOpConfig>(config);
  const [erro, setErro] = useState<string | null>(null);

  const gravar = (novo: FieldOpConfig) => {
    setRascunho(novo);
    const r = fieldOpConfigSchema.safeParse(novo);
    if (!r.success) {
      const i = r.error.issues[0]?.path[1];
      setErro(typeof i === "number" ? `${t("Complete a operação")} ${i + 1}.` : t("Adicione ao menos uma operação."));
      return;
    }
    setErro(null);
    onChange(r.data);
  };
  const trocar = (i: number, op: FieldOp) => gravar({ ops: rascunho.ops.map((x, j) => (j === i ? op : x)) });

  return (
    <div className="space-y-4" data-testid="field-op-form">
      {rascunho.ops.map((op, i) => (
        <div key={i} className="space-y-3 rounded-sm border border-border p-2" data-testid={`operacao-${i}`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted">
              {t("Campo")} {i + 1}
            </span>
            {rascunho.ops.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Remover operação")}
                onClick={() => gravar({ ops: rascunho.ops.filter((_, j) => j !== i) })}
              >
                <Trash size={14} aria-hidden />
              </Button>
            )}
          </div>
          <Campo id={`operacao-${i}-campo`} rotulo={t("Campo")}>
            <SeletorDeCampo
              id={`operacao-${i}-campo`}
              valor={op.target}
              paraEscrita
              onChange={(target) => trocar(i, { ...op, target })}
            />
          </Campo>
          <Campo id={`operacao-${i}-op`} rotulo={t("Operação")}>
            <Seletor
              id={`operacao-${i}-op`}
              valor={op.op}
              opcoes={(Object.keys(OPERACOES_DE_CAMPO) as Array<FieldOp["op"]>).map((k) => ({
                valor: k,
                rotulo: t(OPERACOES_DE_CAMPO[k]),
              }))}
              onChange={(v) => {
                const nova = v as FieldOp["op"];
                trocar(i, nova === "clear" ? { target: op.target, op: nova } : { ...op, op: nova, value: op.value ?? "" });
              }}
            />
          </Campo>
          {op.op !== "clear" && (
            <Campo id={`operacao-${i}-valor`} rotulo={t("Valor")} ajuda={t(AJUDA_DAS_VARIAVEIS)}>
              <Input
                id={`operacao-${i}-valor`}
                maxLength={2000}
                value={op.value ?? ""}
                onChange={(e) => trocar(i, { ...op, value: e.target.value })}
              />
            </Campo>
          )}
          <p className="text-xs text-text-muted">{fraseDaOperacao(op)}</p>
        </div>
      ))}
      {rascunho.ops.length < 20 && (
        <Button type="button" variant="outline" size="sm" onClick={() => gravar({ ops: [...rascunho.ops, operacaoEmBranco()] })}>
          <Plus size={14} aria-hidden className="mr-1" /> {t("Campo")}
        </Button>
      )}
      {erro && <p className="text-xs text-error-fg">{erro}</p>}
    </div>
  );
}
