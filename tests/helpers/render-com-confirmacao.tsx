/**
 * `render` do Testing Library já dentro do `ProvedorDeConfirmacao`, que em
 * produção vem de `app/app/layout.tsx`. Tela que chama `useConfirmar()` lança
 * sem ele; o teste que a monta sozinha usa este `render` no lugar do original.
 */
import { render as renderBase, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";

import { ProvedorDeConfirmacao } from "@/components/ui/confirmar";

export function render(ui: ReactElement, opcoes?: Omit<RenderOptions, "wrapper">) {
  return renderBase(ui, { wrapper: ProvedorDeConfirmacao, ...opcoes });
}
