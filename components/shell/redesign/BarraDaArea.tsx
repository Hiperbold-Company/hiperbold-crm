"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { AlertsBell } from "@/components/shell/AlertsBell";
import { AvisoDePropostaEmDestaque } from "@/components/shell/AvisoDePropostaEmDestaque";
import { BotaoAjuda } from "@/components/shell/BotaoAjuda";
import { SearchTrigger } from "@/components/shell/SearchTrigger";
import { SinoDeTarefas } from "@/components/shell/SinoDeTarefas";
import { useT } from "@/hooks/i18n/useT";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";
import { cn } from "@/lib/utils";

import { abaDaTela, useNavegacaoDaMoldura } from "./navegacao";

/**
 * Esmaece a borda da faixa de abas do lado em que ainda há aba escondida.
 * Sem isto, a rolagem até a aba atual deixava o primeiro rótulo cortado ao
 * meio ("…s goal"), sem nenhum sinal de que a faixa rola.
 */
export function mascaraDaFaixa(scrollLeft: number, clientWidth: number, scrollWidth: number) {
  const folga = 1;
  const esquerda = scrollLeft > folga;
  const direita = scrollLeft + clientWidth < scrollWidth - folga;
  if (!esquerda && !direita) return undefined;
  const a = esquerda ? "transparent 0, #000 32px" : "#000 0";
  const b = direita ? "#000 calc(100% - 32px), transparent 100%" : "#000 100%";
  return `linear-gradient(to right, ${a}, ${b})`;
}

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
  const faixa = useRef<HTMLElement>(null);
  const [mascara, setMascara] = useState<string | undefined>(undefined);
  // Uma aba só: a de caminho mais longo que contém a tela atual. Sem isto,
  // "/app/tasks/planos" acendia "Tarefas" e "Planos de tarefa" juntas.
  const abaAtual = abaDaTela(nav.pathname, abas.map((aba) => aba.href));

  // Áreas com muitas abas (Configurações) passam da largura: a aba da tela
  // atual pode nascer fora da vista. Rola só a faixa (nunca a página) até ela.
  useEffect(() => {
    const n = faixa.current;
    const aba = n?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!n || !aba) return;
    const inicio = aba.offsetLeft - n.offsetLeft;
    const fim = inicio + aba.offsetWidth;
    if (inicio < n.scrollLeft || fim > n.scrollLeft + n.clientWidth) {
      n.scrollLeft = Math.max(0, inicio - 24);
    }
  }, [nav.pathname]);

  useEffect(() => {
    const n = faixa.current;
    if (!n) return;
    const medir = () => setMascara(mascaraDaFaixa(n.scrollLeft, n.clientWidth, n.scrollWidth));
    medir();
    n.addEventListener("scroll", medir, { passive: true });
    window.addEventListener("resize", medir);
    return () => {
      n.removeEventListener("scroll", medir);
      window.removeEventListener("resize", medir);
    };
  }, [nav.pathname, abas.length]);

  return (
    <header
      data-moldura="redesign"
      className="sticky top-[var(--faixas-de-cima,0px)] z-20 flex min-h-14 items-center gap-2 border-b border-border bg-surface px-3 md:px-6"
    >
      <div className={cn("flex min-w-0 items-center gap-2", abas.length > 0 && "md:hidden")}>
        {nav.titulo && (
          <span className="truncate text-base font-semibold">{t(nav.titulo)}</span>
        )}
      </div>
      <nav
        ref={faixa}
        aria-label={t("Seções da área")}
        className="hidden min-w-0 flex-1 self-stretch overflow-x-auto md:flex"
        style={mascara ? { maskImage: mascara, WebkitMaskImage: mascara } : undefined}
      >
        {abas.map((aba) => {
          const aqui = aba.href === abaAtual;
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
