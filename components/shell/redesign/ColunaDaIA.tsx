"use client";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";
import { cn } from "@/lib/utils";

import { abaDaTela, useNavegacaoDaMoldura } from "./navegacao";

/**
 * A COLUNA LATERAL DO V49, nas duas áreas que a têm:
 *   - IA: Montar / Ensinar / Acompanhar;
 *   - Configurações: Você / Empresa / Integrações, com o título "Configurações"
 *     levando ao índice (`/app/settings`).
 *
 * Só no desktop; fora dessas áreas devolve null. Os grupos vêm de
 * `useNavegacaoDaMoldura` (já filtrados pelo papel). No celular a coluna não
 * existe: lá a porta de Configurações continua sendo o índice.
 */
export function ColunaDaIA() {
  const t = useT();
  const nav = useNavegacaoDaMoldura();
  const intencao = usePrefetchPorIntencao();
  const daIA = nav.area?.id === "ia";
  const grupos = daIA ? nav.gruposDaIA : nav.gruposDasConfiguracoes;
  if (grupos.length === 0) return null;

  const atual = abaDaTela(
    nav.pathname,
    grupos.flatMap((g) => g.itens.map((i) => i.href)),
  );
  // O título leva ao índice só em Configurações e só se o papel vê o hub.
  const hub = daIA ? undefined : nav.rodape;
  const noHub = !!hub && nav.pathname === hub.href;

  return (
    <nav
      aria-label={daIA ? t("Seções da IA") : t("Seções das Configurações")}
      data-moldura="redesign"
      className="hidden w-52 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-surface px-3 py-4 md:flex"
    >
      {hub && (
        <Link
          href={hub.href}
          {...intencao(hub.href)}
          aria-current={noHub ? "page" : undefined}
          className="rounded-lg px-3 pt-1 text-base font-semibold text-foreground transition-colors hover:text-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("Configurações")}
        </Link>
      )}
      {grupos.map((grupo) => (
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
