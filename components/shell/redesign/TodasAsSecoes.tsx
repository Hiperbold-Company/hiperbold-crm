"use client";
import Link from "next/link";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";
import { ArrowRight, CaretRight, MagnifyingGlass } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { estaEm, type NavegacaoDaMoldura } from "./navegacao";

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * "Todas as seções": o inventário completo, por grupo, com busca.
 *
 * É o que o "Mais" abre, no menu lateral e na barra do celular. Sai de
 * `searchable()` (a projeção do ⌘K: todo destino que este papel vê) e do hub
 * de cada grupo — nenhuma porta que o produto mostra fica de fora, e nenhuma
 * que ele esconde aparece.
 *
 * `celular` muda só o desenho (o "Mais" do celular no v49): cada grupo vira um
 * cartão com linhas de 48px, divisória fina e chevron. A lista rola numa região
 * própria (teto de 55% da tela), para a conta, o tema, o idioma e o "Sair", que
 * vêm depois na gaveta, continuarem a um gesto. Destinos, ordem e busca são os
 * mesmos.
 */
export function TodasAsSecoes({
  todas,
  pathname,
  onNavigate,
  celular = false,
}: Pick<NavegacaoDaMoldura, "todas" | "pathname"> & { onNavigate?: () => void; celular?: boolean }) {
  const t = useT();
  const intencao = usePrefetchPorIntencao();
  const [busca, setBusca] = useState("");
  const q = semAcento(busca.trim());

  const grupos = todas
    .map(({ group, items }) => {
      const doGrupo = semAcento(t(group.label)).includes(q);
      return {
        group,
        items: items.filter((d) => !q || doGrupo || semAcento(t(d.label)).includes(q)),
        hub: group.hub && (!q || doGrupo || semAcento(t(group.hub.label)).includes(q)) ? group.hub : undefined,
      };
    })
    .filter((g) => g.items.length > 0 || g.hub);

  if (celular) {
    return (
      <div className="flex shrink-0 flex-col gap-3">
        <div className="relative">
          <MagnifyingGlass
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            aria-label={t("Buscar seção")}
            placeholder={t("Buscar seção…")}
            className="h-11 w-full rounded-xl border border-border-strong bg-surface pr-3 pl-9 text-base text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex max-h-[55dvh] flex-col gap-4 overflow-y-auto overscroll-contain">
        {grupos.length === 0 && (
          <p className="px-1 py-2 text-sm text-muted-foreground">{t("Nenhuma seção com esse nome.")}</p>
        )}
        {grupos.map(({ group, items, hub }) => (
          <section key={group.id} className="flex shrink-0 flex-col gap-1.5" aria-labelledby={`todas-${group.id}`}>
            <h3
              id={`todas-${group.id}`}
              className="block px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {t(group.label)}
            </h3>
            <div className="overflow-hidden rounded-2xl border border-border bg-surface">
              {items.map((d) => {
                const Icone = d.icon;
                const aqui = estaEm(pathname, d.href);
                return (
                  <Link
                    key={d.href}
                    href={d.href}
                    {...intencao(d.href)}
                    onClick={onNavigate}
                    aria-current={aqui ? "page" : undefined}
                    className={cn(
                      "flex min-h-12 items-center gap-3 border-b border-border px-4 py-2 text-base last:border-b-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      aqui ? "bg-accent-soft font-semibold text-accent" : "text-foreground active:bg-surface-elevated",
                    )}
                  >
                    <Icone size={20} aria-hidden className={aqui ? undefined : "text-muted-foreground"} />
                    <span className="min-w-0 flex-1 truncate">{t(d.label)}</span>
                    <CaretRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
                  </Link>
                );
              })}
              {hub && (
                <Link
                  href={hub.href}
                  {...intencao(hub.href)}
                  onClick={onNavigate}
                  aria-current={pathname === hub.href ? "page" : undefined}
                  className="flex min-h-12 items-center gap-3 border-b border-border px-4 py-2 text-base text-muted-foreground last:border-b-0 active:bg-surface-elevated focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <ArrowRight size={20} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{t(hub.label)}</span>
                  <CaretRight size={16} aria-hidden className="shrink-0" />
                </Link>
              )}
            </div>
          </section>
        ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-4 pb-3">
        <MagnifyingGlass
          size={16}
          className="pointer-events-none absolute top-1/2 left-7 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          aria-label={t("Buscar seção")}
          placeholder={t("Buscar seção…")}
          className="h-10 w-full rounded-lg border border-border-strong bg-surface pr-3 pl-9 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border pb-3">
        {grupos.length === 0 && (
          <p className="px-5 py-6 text-sm text-muted-foreground">{t("Nenhuma seção com esse nome.")}</p>
        )}
        {grupos.map(({ group, items, hub }) => (
          <section key={group.id} className="flex flex-col gap-px py-2" aria-labelledby={`todas-${group.id}`}>
            <h3
              id={`todas-${group.id}`}
              className="block px-5 py-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase"
            >
              {t(group.label)}
            </h3>
            {items.map((d) => {
              const Icone = d.icon;
              const aqui = estaEm(pathname, d.href);
              return (
                <Link
                  key={d.href}
                  href={d.href}
                  {...intencao(d.href)}
                  onClick={onNavigate}
                  aria-current={aqui ? "page" : undefined}
                  className={cn(
                    "mx-2 flex min-h-10 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                    aqui ? "bg-accent-soft font-semibold text-accent" : "text-foreground hover:bg-surface-elevated",
                  )}
                >
                  <Icone size={18} aria-hidden className={aqui ? undefined : "text-muted-foreground"} />
                  <span className="truncate">{t(d.label)}</span>
                </Link>
              );
            })}
            {hub && (
              <Link
                href={hub.href}
                {...intencao(hub.href)}
                onClick={onNavigate}
                aria-current={pathname === hub.href ? "page" : undefined}
                className="mx-2 flex min-h-10 items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
              >
                <ArrowRight size={18} aria-hidden />
                <span className="truncate">{t(hub.label)}</span>
              </Link>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
