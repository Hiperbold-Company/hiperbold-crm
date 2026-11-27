"use client";

/**
 * Caixa de marcar do produto. É o `<input type="checkbox">` nativo — mantém
 * formulário, `name`, `required`, leitor de tela e teclado sem dependência —
 * com o tamanho, a cor da marca e o foco do design system. `indeterminado`
 * liga o estado "alguns marcados" (que o HTML só aceita por propriedade).
 */
import * as React from "react";

import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  indeterminado?: boolean;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminado = false, ...props }, ref) => {
    const interno = React.useRef<HTMLInputElement | null>(null);
    React.useImperativeHandle(ref, () => interno.current as HTMLInputElement);
    React.useEffect(() => {
      if (interno.current) interno.current.indeterminate = indeterminado;
    }, [indeterminado]);
    return (
      <input
        ref={interno}
        type="checkbox"
        aria-checked={indeterminado ? "mixed" : undefined}
        data-slot="checkbox"
        className={cn(
          "size-4 shrink-0 cursor-pointer rounded-sm border border-border-strong accent-[var(--color-accent)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Checkbox.displayName = "Checkbox";
