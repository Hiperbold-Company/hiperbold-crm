/**
 * O cabeçalho de toda tela de Configurações: título, descrição e, à direita,
 * ações opcionais (um link de ajuda, um botão que age na hora).
 *
 * Sem hook e sem `"use client"`: os cabeçalhos moram nos `page.tsx`, que são de
 * servidor e traduzem com `traduzir(texto, idioma)`. Por isso o componente
 * recebe o texto JÁ traduzido.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function CabecalhoDaConfiguracao({
  titulo,
  descricao,
  acoes,
  className,
}: {
  titulo: ReactNode;
  descricao?: ReactNode;
  acoes?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-[1_1_22rem] flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{titulo}</h1>
        {descricao ? <p className="max-w-2xl text-sm text-muted-foreground">{descricao}</p> : null}
      </div>
      {acoes ? <div className="flex shrink-0 flex-wrap items-center gap-2">{acoes}</div> : null}
    </header>
  );
}
