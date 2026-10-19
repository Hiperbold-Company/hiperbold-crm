"use client";

import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

/** Acima disto, a pessoa digita a quantidade para confirmar: clicar sem ler não basta para apagar centenas. */
export const LIMITE_SEM_DIGITAR = 50;

export function ExcluirContatosEmLoteDialog({
  open,
  quantidade,
  pendente,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  quantidade: number;
  pendente: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [digitado, setDigitado] = useState("");
  const exigeDigitar = quantidade > LIMITE_SEM_DIGITAR;
  const confere = !exigeDigitar || digitado.trim() === String(quantidade);

  useEffect(() => {
    if (!open) setDigitado("");
  }, [open]);

  const numero = quantidade.toLocaleString("pt-BR");
  return (
    <AlertDialog open={open} onOpenChange={(v) => (pendente ? undefined : onOpenChange(v))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {quantidade === 1
              ? t("Excluir 1 contato?")
              : `${t("Excluir")} ${numero} ${t("contatos")}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "Isso remove os contatos selecionados e as conversas e mensagens deles. Os negócios continuam, sem contato. Contato com compromisso na agenda não é excluído. Esta ação não pode ser desfeita.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {exigeDigitar && (
          <div className="space-y-2">
            <Label htmlFor="confirmar-exclusao-em-lote" className="text-sm">
              {t("Para confirmar, digite a quantidade:")} <strong>{quantidade}</strong>
            </Label>
            <Input
              id="confirmar-exclusao-em-lote"
              inputMode="numeric"
              autoComplete="off"
              value={digitado}
              onChange={(e) => setDigitado(e.target.value)}
              disabled={pendente}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pendente}>{t("Cancelar")}</AlertDialogCancel>
          <Button variant="destructive" onClick={onConfirm} disabled={pendente || !confere}>
            {pendente ? t("Excluindo…") : t("Excluir")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
