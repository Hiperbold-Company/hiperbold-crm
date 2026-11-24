"use client";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";
import { cn } from "@/lib/utils";

import { abaDaTela, useNavegacaoDaMoldura } from "./navegacao";

/**
 * A COLUNA LATERAL DA IA (v49): Montar / Ensinar / Acompanhar.
 *
 * Só no desktop e só quando a tela está na área IA; fora dela devolve null.
 * Os grupos vêm de `useNavegacaoDaMoldura` (já filtrados pelo papel).
 */
export function ColunaDaIA() {
  const t = useT();
  const nav = useNavegacaoDaMoldura();
  const intencao = usePrefetchPorIntencao();
  if (nav.area?.id !== "ia" || nav.gruposDaIA.length === 0) return null;

  const atual = abaDaTela(
    nav.pathname,
    nav.gruposDaIA.flatMap((g) => g.itens.map((i) => i.href)),
  );

  return (
    <nav
      aria-label={t("Seções da IA")}
      data-moldura="redesign"
      className="hidden w-52 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-surface px-3 py-4 md:flex"
    >
      {nav.gruposDaIA.map((grupo) => (
        <div key={grupo.rotulo} className="flex flex-col gap-0.5">
          <h2 className="px-3 pb-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            {t(grupo.rotulo)}
          </h2>
          {grupo.itens.map((item) => {
            const aqui = item.href === atual;
            return (
              <Link
                key={item.href}
                href={item.href}
                {...intencao(item.href)}
                aria-current={aqui ? "page" : undefined}
                className={cn(
                  "rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                  aqui
                    ? "bg-accent-soft font-semibold text-accent"
                    : "text-muted-foreground hover:bg-surface-elevated hover:text-foreground",
                )}
              >
                {t(item.label)}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
