"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { DownloadSimple } from "@/lib/ui/icons";

/**
 * Baixa a automação como `.automacao.json` (`GET /api/v1/automacoes/:id/exportar`):
 * o arquivo que «Importar» aceita, nesta ou em outra conta. Leva o que está
 * GRAVADO (o rascunho, ou a versão no ar).
 */
export function ExportarAutomacaoButton({ flowId, size = "sm" }: { flowId: string; size?: "sm" | "default" }) {
  const t = useT();
  const [enviando, setEnviando] = useState(false);

  const exportar = async () => {
    setEnviando(true);
    try {
      const resp = await fetch(`/api/v1/automacoes/${flowId}/exportar`);
      const corpo = (await resp.json().catch(() => null)) as {
        data?: { file_name: string; file: unknown };
        error?: { message?: string };
      } | null;
      if (!resp.ok || !corpo?.data) {
        toast.error(corpo?.error?.message ?? t("Não consegui exportar a automação. Tente de novo."));
        return;
      }
      const blob = new Blob([JSON.stringify(corpo.data.file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = corpo.data.file_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("Automação exportada."));
    } catch {
      toast.error(t("Não consegui exportar a automação. Tente de novo."));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={enviando}
      data-testid="exportar-automacao"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void exportar();
      }}
    >
      <DownloadSimple size={14} aria-hidden className="mr-1" />
      {enviando ? t("Exportando…") : t("Exportar")}
    </Button>
  );
}
