"use client";

/**
 * O editor da lista de motivos de perda da ORGANIZAÇÃO (1021). Mesma UX que o campo tinha em Etapas
 * do funil: os motivos numa caixa, separados por vírgula, e uma categoria opcional para cada um.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { salvarMotivosDePerda } from "@/app/actions/settings/salvarMotivosDePerda";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";
import { listaDoTexto, rotulosECategorias } from "@/lib/leads/motivos-da-organizacao-regua";
import { CATEGORIAS_DE_PERDA } from "@/lib/schemas/leads";

export function MotivosDePerdaClient({ iniciais }: { iniciais: unknown[] }) {
  const t = useT();
  const inicial = rotulosECategorias(iniciais);
  const [texto, setTexto] = useState(inicial.rotulos.join(", "));
  const [categorias, setCategorias] = useState<Record<string, string>>(inicial.categorias);
  const [isPending, startTransition] = useTransition();

  const motivosDaCaixa = texto
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  function salvar() {
    const lista = listaDoTexto(texto, categorias);
    if (lista.length > 50) {
      toast.error(t("A lista aceita no máximo 50 motivos de perda."));
      return;
    }
    if (lista.some((m) => (typeof m === "string" ? m : m.label).length > 80)) {
      toast.error(t("Cada motivo de perda cabe em até 80 caracteres."));
      return;
    }
    startTransition(async () => {
      const r = await salvarMotivosDePerda(lista);
      if (r.ok) toast.success(r.mudou ? t("Motivos de perda salvos.") : t("Nada mudou."));
      else if (r.error === "mfa_required") irAoDesafioDeMfa();
      else toast.error(`${t("Erro:")} ${r.error}`);
    });
  }

  return (
    <Card className="max-w-3xl space-y-3 p-4" data-testid="motivos-de-perda-da-empresa">
      <div className="space-y-1">
        <Label className="text-xs" htmlFor="motivos-de-perda">
          {t("Motivos de perda (separados por vírgula)")}
        </Label>
        <Input id="motivos-de-perda" value={texto} onChange={(e) => setTexto(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {t("Sem nenhum motivo cadastrado, a equipe escolhe entre os motivos padrão do produto. \"Outro motivo\" está sempre na lista.")}
        </p>
      </div>
      {motivosDaCaixa.map((motivo) => {
        const opcoes = [...new Set([...CATEGORIAS_DE_PERDA, ...(categorias[motivo] ? [categorias[motivo]] : [])])];
        return (
          <div key={motivo} className="flex items-center gap-2">
            <span className="w-56 truncate text-xs text-muted-foreground">{motivo}</span>
            <Select
              value={categorias[motivo] ?? "__sem__"}
              onValueChange={(valor) =>
                setCategorias((atual) => {
                  const proximo = { ...atual };
                  if (valor === "__sem__") delete proximo[motivo];
                  else proximo[motivo] = valor;
                  return proximo;
                })
              }
            >
              <SelectTrigger className="h-8 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__sem__">{t("Sem categoria")}</SelectItem>
                {opcoes.map((categoria) => (
                  <SelectItem key={categoria} value={categoria}>
                    {categoria}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
      <div className="flex justify-end">
        <Button onClick={salvar} disabled={isPending}>
          {isPending ? t("Salvando...") : t("Salvar")}
        </Button>
      </div>
    </Card>
  );
}
