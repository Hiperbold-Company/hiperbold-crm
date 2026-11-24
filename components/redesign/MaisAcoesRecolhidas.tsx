"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { useT } from "@/hooks/i18n/useT";
import { DotsThree } from "@/lib/ui/icons";

/**
 * O "MAIS AÇÕES" DO REDESIGN (onda 3): as ações raras de um cabeçalho num
 * `<details>` que só ESCONDE. Nada desmonta — os diálogos das ações continuam
 * vivos, e o conjunto do que cada papel alcança é o mesmo da tela de sempre.
 *
 * Fecha com Esc, com clique fora e ao escolher uma ação (o diálogo da ação
 * abre por portal e não depende de a lista seguir aberta). Por isso só cabe
 * aqui ação que abre DIÁLOGO; popover ancorado num botão de dentro sumiria
 * junto com a lista.
 *
 * As marcas vêm de quem usa (`data-rd-chat`, `data-rd-contatos`…), e quem usa
 * só monta este componente com a chave do redesign ligada.
 */
export function MaisAcoesRecolhidas({
  marca,
  marcaDaLista,
  children,
}: {
  marca: Record<string, string | undefined>;
  marcaDaLista: Record<string, string | undefined>;
  children: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function fora(e: PointerEvent) {
      const el = ref.current;
      if (el?.open && e.target instanceof Node && !el.contains(e.target)) el.open = false;
    }
    document.addEventListener("pointerdown", fora);
    return () => document.removeEventListener("pointerdown", fora);
  }, []);

  return (
    <details
      ref={ref}
      {...marca}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.open = false;
      }}
    >
      <summary aria-label={t("Mais ações")} title={t("Mais ações")}>
        <DotsThree size={18} weight="bold" aria-hidden />
      </summary>
      {/* Escolher uma ação fecha a lista; o diálogo dela segue montado. Na fase
          de captura: botão que para a propagação (Exportar, Excluir do editor de
          automações) deixava a lista aberta por cima do diálogo. */}
      <div
        {...marcaDaLista}
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest("button, a")) {
            (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}
