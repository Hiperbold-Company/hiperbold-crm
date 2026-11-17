"use client";

/**
 * Paginação de lista: "Anterior", a posição e "Próxima". Serve às duas formas
 * do produto — botão (`onIr`) e link (`hrefDaPagina`, que mantém a página na
 * URL). Páginas contam a partir de 1. Sem `totalDePaginas` (lista por cursor),
 * a posição mostra só "Página N" e quem chama diz se há próxima (`temProxima`).
 */
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { CaretLeft, CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export interface PaginacaoProps {
  pagina: number;
  totalDePaginas?: number;
  /** Para lista sem total: há próxima página? */
  temProxima?: boolean;
  onIr?: (pagina: number) => void;
  hrefDaPagina?: (pagina: number) => string;
  carregando?: boolean;
  className?: string;
}

export function Paginacao({
  pagina,
  totalDePaginas,
  temProxima,
  onIr,
  hrefDaPagina,
  carregando = false,
  className,
}: PaginacaoProps) {
  const t = useT();
  const temAnterior = pagina > 1;
  const haProxima = totalDePaginas !== undefined ? pagina < totalDePaginas : Boolean(temProxima);
  const posicao =
    totalDePaginas !== undefined
      ? t("Página {a} de {b}").replace("{a}", String(pagina)).replace("{b}", String(Math.max(totalDePaginas, 1)))
      : t("Página {a}").replace("{a}", String(pagina));

  function botao(alvo: number, ativo: boolean, rotulo: string, anterior: boolean) {
    const conteudo = (
      <>
        {anterior ? <CaretLeft size={14} aria-hidden /> : null}
        <span>{rotulo}</span>
        {!anterior ? <CaretRight size={14} aria-hidden /> : null}
      </>
    );
    const desligado = !ativo || carregando;
    if (hrefDaPagina && !desligado) {
      return (
        <Button asChild variant="outline" size="sm">
          <Link href={hrefDaPagina(alvo)} aria-label={anterior ? t("Página anterior") : t("Próxima página")}>
            {conteudo}
          </Link>
        </Button>
      );
    }
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={desligado}
        aria-label={anterior ? t("Página anterior") : t("Próxima página")}
        onClick={() => onIr?.(alvo)}
      >
        {conteudo}
      </Button>
    );
  }

  return (
    <nav aria-label={t("Paginação")} className={cn("flex items-center justify-between gap-3", className)}>
      {botao(pagina - 1, temAnterior, t("Anterior"), true)}
      <span className="text-sm text-text-muted tabular-nums" aria-live="polite">
        {posicao}
      </span>
      {botao(pagina + 1, haProxima, t("Próxima"), false)}
    </nav>
  );
}
