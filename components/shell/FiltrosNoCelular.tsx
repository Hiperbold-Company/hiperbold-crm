"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { FunnelSimple } from "@/lib/ui/icons";
import { useAbaixoDeMd } from "@/hooks/useAbaixoDeMd";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  children: ReactNode;
  /** Quantos filtros estão diferentes do padrão; aparece no botão como "(N)". */
  ativos?: number;
  titulo?: string;
}

/**
 * No computador (md+) devolve os filtros como estão. No celular troca por um
 * botão "Filtros" que abre uma gaveta de baixo. Os `children` são renderizados
 * uma vez só (inline ou dentro da gaveta), então o estado segue no pai.
 */
export function FiltrosNoCelular({ children, ativos = 0, titulo }: Props) {
  const t = useT();
  const celular = useAbaixoDeMd();
  const [aberto, setAberto] = useState(false);

  if (!celular) return <>{children}</>;

  return (
    <>
      <Button variant="outline" size="sm" aria-expanded={aberto} aria-haspopup="dialog" onClick={() => setAberto(true)}>
        <FunnelSimple size={16} weight="bold" aria-hidden />
        <span>{ativos > 0 ? `${t("Filtros")} (${ativos})` : t("Filtros")}</span>
      </Button>
      <Sheet open={aberto} onOpenChange={setAberto}>
        <SheetContent side="bottom" className="flex max-h-[85dvh] flex-col gap-3 overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{titulo ?? t("Filtros")}</SheetTitle>
            <SheetDescription className="sr-only">{t("Escolha os filtros e toque em Ver resultados.")}</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 [&>*]:w-full">{children}</div>
          <Button onClick={() => setAberto(false)}>{t("Ver resultados")}</Button>
        </SheetContent>
      </Sheet>
    </>
  );
}
