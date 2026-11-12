"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { CHAVES_DE_COR_DA_CONEXAO, PALETA_DA_CONEXAO, lerCorDaConexao, variaveisDaCor, type CorDaConexao } from "@/lib/conexoes/cores";
import { PencilSimple } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { EtiquetaDaConexao } from "./EtiquetaDaConexao";

export function RenomearConexao({
  channelId,
  currentName,
  onSaved,
  comCor = false,
  currentColor = null,
}: {
  channelId: string;
  currentName: string | null;
  onSaved: () => void | Promise<unknown>;
  /**
   * Oferece também a cor da etiqueta (migration 1012). Desligado, o diálogo é o
   * de sempre: só o nome, e o corpo do PATCH leva só `display_name`.
   */
  comCor?: boolean;
  currentColor?: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName ?? "");
  const [cor, setCor] = useState<CorDaConexao | null>(lerCorDaConexao(currentColor));
  const [saving, setSaving] = useState(false);

  useEffect(() => setName(currentName ?? ""), [currentName]);

  // #2892: o `name` digitado sobrevivia ao Cancelar e reaparecia na
  // reabertura — o useEffect acima só repunha quando `currentName` MUDAVA.
  // Repor na abertura cobre as duas portas: o clique em Renomear e qualquer
  // `onOpenChange(true)`; o Cancelar (e o X, e o Escape) só fecham.
  function abrirDialogo() {
    setName(currentName ?? "");
    setCor(lerCorDaConexao(currentColor));
    setOpen(true);
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed && !comCor) return;
    setSaving(true);
    try {
      await apiClient.patch(
        `/api/v1/channel-sessions/${channelId}/name`,
        comCor
          ? { ...(trimmed ? { display_name: trimmed } : {}), label_color: cor }
          : { display_name: trimmed },
      );
      toast.success(t("Nome interno atualizado."));
      setOpen(false);
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Não foi possível salvar o nome."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={abrirDialogo}>
        <PencilSimple size={14} aria-hidden />
        {comCor ? t("Editar nome e cor") : t("Renomear")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? abrirDialogo() : setOpen(false))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Nome interno da conexão")}</DialogTitle>
            <DialogDescription>
              {t("Só a sua equipe vê este nome. O nome público no provedor não muda.")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`connection-name-${channelId}`}>{t("Nome interno")}</Label>
            <Input
              id={`connection-name-${channelId}`}
              value={name}
              maxLength={80}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
              placeholder={t("Ex.: WA | Fixo 7906")}
            />
            {comCor && (
              <>
                <span className="mt-2 text-sm font-medium" id={`connection-color-${channelId}`}>
                  {t("Cor da etiqueta no Chat")}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby={`connection-color-${channelId}`}
                  className="flex flex-wrap gap-2"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={cor === null}
                    aria-label={t("Sem cor")}
                    title={t("Sem cor")}
                    onClick={() => setCor(null)}
                    className={cn(
                      "h-7 rounded-full border border-border px-2 text-xs text-text-muted",
                      "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent",
                      cor === null && "ring-2 ring-accent",
                    )}
                  >
                    {t("Sem cor")}
                  </button>
                  {CHAVES_DE_COR_DA_CONEXAO.map((chave) => (
                    <button
                      key={chave}
                      type="button"
                      role="radio"
                      aria-checked={cor === chave}
                      aria-label={t(PALETA_DA_CONEXAO[chave].nome)}
                      title={t(PALETA_DA_CONEXAO[chave].nome)}
                      onClick={() => setCor(chave)}
                      style={variaveisDaCor(chave) ?? undefined}
                      className={cn(
                        "h-7 w-7 rounded-full border border-border",
                        "bg-[color:var(--etq-conexao-fundo)] dark:bg-[color:var(--etq-conexao-fundo-escuro)]",
                        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent",
                        cor === chave && "ring-2 ring-accent",
                      )}
                    />
                  ))}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  {t("Prévia no Chat:")}
                  <EtiquetaDaConexao texto={name.trim() || currentName || t("WhatsApp")} cor={cor} />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              {t("Cancelar")}
            </Button>
            <Button onClick={() => void save()} disabled={saving || (!comCor && !name.trim())}>
              {saving ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
