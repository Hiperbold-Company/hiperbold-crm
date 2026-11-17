/**
 * Uma seção de uma tela de Configurações: um cartão com título, descrição
 * opcional e os campos. O `id` serve de âncora ("Nesta página") e o título
 * nomeia a região para leitor de tela.
 *
 * Sem hook: serve tanto a componente de cliente quanto a `page.tsx` de servidor.
 * O texto chega já traduzido.
 */
import { useId, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils";

interface Props extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  titulo: ReactNode;
  descricao?: ReactNode;
  /** Algo à direita do título (um interruptor, um selo). */
  acao?: ReactNode;
  children?: ReactNode;
}

export function SecaoDaConfiguracao({
  titulo,
  descricao,
  acao,
  children,
  className,
  id,
  ...resto
}: Props) {
  const gerado = useId();
  const idDoTitulo = `${id ?? gerado}-titulo`;
  return (
    <section
      id={id}
      aria-labelledby={idDoTitulo}
      className={cn(
        "scroll-mt-6 rounded-lg border border-border bg-surface text-text shadow-xs",
        className,
      )}
      {...resto}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={idDoTitulo} className="text-base font-semibold tracking-tight">
            {titulo}
          </h2>
          {descricao ? <div className="text-sm text-muted-foreground">{descricao}</div> : null}
        </div>
        {acao ? <div className="shrink-0">{acao}</div> : null}
      </div>
      <div className="flex flex-col gap-4 p-5">{children}</div>
    </section>
  );
}
