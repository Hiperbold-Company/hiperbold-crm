"use client";

import { DownloadSimple, Trash, X } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

/** A barra que aparece com a seleção: quantos, excluir, exportar, limpar. */
export function BarraDeSelecaoDeContatos({
  quantidade,
  podeExcluir,
  podeExportar,
  exportando,
  onExcluir,
  onExportar,
  onLimpar,
}: {
  quantidade: number;
  podeExcluir: boolean;
  podeExportar: boolean;
  exportando: boolean;
  onExcluir: () => void;
  onExportar: () => void;
  onLimpar: () => void;
}) {
  const t = useT();
  return (
    <div
      role="region"
      aria-label={t("Ações em lote")}
      data-barra-de-selecao
      className="flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-accent/10 p-2"
    >
      <span className="px-1 text-sm font-medium" aria-live="polite">
        {quantidade.toLocaleString("pt-BR")} {quantidade === 1 ? t("selecionado") : t("selecionados")}
      </span>
      {podeExcluir && (
        <Button variant="destructive" size="sm" onClick={onExcluir}>
          <Trash size={16} weight="bold" aria-hidden />
          <span>{t("Excluir")}</span>
        </Button>
      )}
      {podeExportar && (
        <Button variant="outline" size="sm" onClick={onExportar} disabled={exportando}>
          <DownloadSimple size={16} weight="bold" aria-hidden />
          <span>{exportando ? t("Gerando…") : t("Exportar CSV")}</span>
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onLimpar}>
        <X size={16} weight="bold" aria-hidden />
        <span>{t("Limpar seleção")}</span>
      </Button>
    </div>
  );
}
