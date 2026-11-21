"use client";
import Link from "next/link";

import { AlertsBell } from "@/components/shell/AlertsBell";
import { AvisoDePropostaEmDestaque } from "@/components/shell/AvisoDePropostaEmDestaque";
import { BotaoAjuda } from "@/components/shell/BotaoAjuda";
import { SearchTrigger } from "@/components/shell/SearchTrigger";
import { SinoDeTarefas } from "@/components/shell/SinoDeTarefas";
import { useT } from "@/hooks/i18n/useT";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";
import { cn } from "@/lib/utils";

import { caminhoNoCatalogo, estaEm, useNavegacaoDaMoldura } from "./navegacao";

/**
 * O TOPO DA ÁREA DE CONTEÚDO na moldura nova.
 *
 * O protótipo põe aqui só as abas da área. As ferramentas que a casca de
 * sempre tem no topo — busca (⌘K), ajuda da tela, sino de tarefas, alertas e
 * o aviso de proposta — não têm lugar desenhado no protótipo, e sumir com elas
 * mudaria a função; ficam à direita desta mesma faixa, os mesmos componentes.
 *
 * As abas são os destinos que este papel vê no MESMO grupo e na MESMA seção
 * do catálogo que a tela atual (`useNavegacaoDaMoldura`). Com menos de duas,
 * não há abas a mostrar.
 *
 * No celular a faixa mostra o nome da tela atual no lugar das abas, como no
 * protótipo; a troca de empresa mora no "Mais" da barra de baixo.
 */
export function BarraDaArea({ ajudaBase = null }: { ajudaBase?: string | null }) {
  const t = useT();
  const nav = useNavegacaoDaMoldura();
  const intencao = usePrefetchPorIntencao();
  const abas = nav.abasDaArea.length >= 2 ? nav.abasDaArea : [];

  return (
    <header
      data-moldura="redesign"
      className="sticky top-[var(--faixas-de-cima,0px)] z-20 flex min-h-14 items-center gap-2 border-b border-border bg-surface px-3 md:px-6"
    >
      <div className="flex min-w-0 items-center gap-2 md:hidden">
        {nav.titulo && (
          <span className="truncate text-base font-semibold">{t(nav.titulo)}</span>
        )}
      </div>
      <nav
        aria-label={t("Seções da área")}
        className="hidden min-w-0 flex-1 self-stretch overflow-x-auto md:flex"
      >
        {abas.map((aba) => {
          const aqui = estaEm(caminhoNoCatalogo(nav.pathname), aba.href);
          return (
            <Link
              key={aba.href}
              href={aba.href}
              {...intencao(aba.href)}
              aria-current={aqui ? "page" : undefined}
              className={cn(
                "inline-flex shrink-0 items-center px-3 text-sm whitespace-nowrap transition-colors",
                aqui
                  ? "font-semibold text-accent shadow-[inset_0_-2px_0_var(--color-accent)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(aba.label)}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 md:gap-2">
        <SearchTrigger />
        <BotaoAjuda base={ajudaBase} />
        <SinoDeTarefas />
        <AlertsBell />
        <AvisoDePropostaEmDestaque />
      </div>
    </header>
  );
}
