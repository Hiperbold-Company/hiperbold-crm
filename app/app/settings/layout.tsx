import type { ReactNode } from "react";

import { redesignLigado } from "@/lib/redesign/chave";
import { marcaDasConfiguracoes } from "@/lib/redesign/configuracoes";

/**
 * Configurações no redesign: com a chave ligada, o conteúdo ganha uma casca
 * (`display: contents` no CSS, sem caixa própria) que escopa o visual novo de
 * toda a área. Desligada devolve os filhos como estão — o DOM não muda.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const rd = marcaDasConfiguracoes(redesignLigado());
  if (!rd("area")) return <>{children}</>;
  return <div data-rd-configuracoes={rd("area")}>{children}</div>;
}
