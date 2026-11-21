"use client";
import Link from "next/link";
import { useState, useTransition } from "react";

import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { ContadorDaFila } from "@/components/shell/ContadorDaFila";
import { ContadorDeCasos } from "@/components/shell/ContadorDeCasos";
import { ContadorDeTarefas } from "@/components/shell/ContadorDeTarefas";
import { VersionFooter } from "@/components/shell/VersionFooter";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useT } from "@/hooks/i18n/useT";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";
import { CAMINHO_PADRAO_DA_AJUDA, urlNaCentral } from "@/lib/ajuda/artigos";
import { useBaseDaCentralDeAjuda } from "@/lib/ajuda/contexto";
import type { NavDestination } from "@/lib/navigation/registry";
import { ArrowSquareOut, CaretDoubleLeft, CaretDoubleRight, DotsThree, Gear, Question } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { CartaoDaEmpresa, MarcaDoMenu } from "./MarcaECartaoDaEmpresa";
import { MenuDoUsuarioNovo } from "./MenuDoUsuarioNovo";
import { estaEm, useNavegacaoDaMoldura } from "./navegacao";
import { TodasAsSecoes } from "./TodasAsSecoes";

/** Item do trilho: ícone com rótulo curto embaixo (recolhido) ou em linha (aberto). */
function classeDoItem(aberto: boolean, ativo: boolean): string {
  return cn(
    "relative flex w-full items-center rounded-lg transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
    aberto ? "gap-3 px-3 py-2 text-sm" : "flex-col gap-1 px-0 py-1.5 text-2xs font-medium",
    ativo
      ? "bg-accent-soft font-semibold text-accent"
      : "text-muted-foreground hover:bg-surface-elevated hover:text-foreground",
  );
}

function Contador({ item, compacto }: { item: NavDestination; compacto: boolean }) {
  if (item.contador === "casos") return <ContadorDeCasos compacto={compacto} />;
  if (item.contador === "fila") return <ContadorDaFila compacto={compacto} />;
  if (item.contador === "tarefas") return <ContadorDeTarefas compacto={compacto} />;
  return null;
}

/**
 * O MENU LATERAL DA MOLDURA NOVA (protótipo: trilho de 76px que abre para 232px).
 *
 * Mesmas portas do `Sidebar` de sempre — `useNavegacaoDaMoldura` projeta o
 * mesmo `sidebarGroups()` —, mesmos contadores, mesmo ponto de saúde da
 * conexão, mesma central de ajuda, mesmo rodapé de Configurações e de versão,
 * e o MESMO cookie de recolher (`toggleSidebar`). Muda só o desenho: lista
 * plana no trilho, e o inventário inteiro atrás do "Mais".
 *
 * `sticky` e nunca `fixed`, com o desconto de `--faixas-de-cima`: o porquê
 * está no `Sidebar` (a barra precisa OCUPAR lugar na linha).
 */
export function MenuLateral({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const aberto = !collapsed;
  const nav = useNavegacaoDaMoldura();
  const intencao = usePrefetchPorIntencao();
  const [recolhendo, startTransition] = useTransition();
  const [maisAberto, setMaisAberto] = useState(false);
  const centralDeAjuda = urlNaCentral(useBaseDaCentralDeAjuda(), CAMINHO_PADRAO_DA_AJUDA);
  const rotuloAlternar = aberto ? t("Recolher menu") : t("Abrir menu");

  return (
    <aside
      data-moldura="redesign"
      className={cn(
        "sticky top-[var(--faixas-de-cima,0px)] z-30 flex h-[calc(100dvh-var(--faixas-de-cima,0px))] shrink-0 flex-col gap-0.5 border-r border-border bg-surface transition-[width] duration-base",
        aberto ? "w-58 p-3" : "w-19 px-2 py-3",
      )}
    >
      <div className={cn("flex min-h-10 items-center pb-3", aberto ? "px-3" : "justify-center")}>
        <MarcaDoMenu aberto={aberto} />
      </div>
      <div className="pb-2.5">
        <CartaoDaEmpresa aberto={aberto} />
      </div>

      <nav aria-label={t("Navegação principal")} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        <ul className="flex flex-col gap-0.5">
          {nav.itens.map((item) => {
            const Icone = item.icon;
            const ativo = estaEm(nav.pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  {...intencao(item.href)}
                  title={aberto ? undefined : t(item.label)}
                  aria-current={ativo ? "page" : undefined}
                  className={classeDoItem(aberto, ativo)}
                >
                  <span className="relative inline-flex shrink-0">
                    <Icone size={20} weight={ativo ? "fill" : "regular"} aria-hidden />
                    {item.healthDot && (
                      <ConnectionHealthDot className="absolute -top-1 -right-1.5" />
                    )}
                  </span>
                  <span className={cn("max-w-full truncate", aberto && "flex-1")}>{t(item.label)}</span>
                  {aberto ? (
                    <Contador item={item} compacto={false} />
                  ) : (
                    <span className="absolute top-1 right-2">
                      <Contador item={item} compacto />
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
          <li>
            <Sheet open={maisAberto} onOpenChange={setMaisAberto}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label={t("Todas as seções")}
                  title={aberto ? undefined : t("Todas as seções")}
                  className={classeDoItem(aberto, maisAberto)}
                >
                  <DotsThree size={20} aria-hidden />
                  <span className={cn("max-w-full truncate", aberto && "flex-1 text-left")}>{t("Mais")}</span>
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-0 p-0">
                <div className="px-5 pt-4 pb-3">
                  <SheetTitle className="text-base font-bold">{t("Todas as seções")}</SheetTitle>
                  <SheetDescription className="sr-only">
                    {t("Todas as telas que você pode abrir, por área.")}
                  </SheetDescription>
                </div>
                <TodasAsSecoes
                  todas={nav.todas}
                  pathname={nav.pathname}
                  onNavigate={() => setMaisAberto(false)}
                />
              </SheetContent>
            </Sheet>
          </li>
        </ul>
      </nav>

      <div className="flex flex-col gap-0.5 pt-2">
        {centralDeAjuda && (
          <a
            href={centralDeAjuda}
            target="_blank"
            rel="noopener noreferrer"
            title={aberto ? undefined : t("Central de ajuda")}
            aria-label={aberto ? undefined : t("Central de ajuda (abre em nova aba)")}
            className={classeDoItem(aberto, false)}
          >
            <Question size={20} aria-hidden />
            <span className={cn("max-w-full truncate", aberto && "flex-1")}>
              {aberto ? t("Central de ajuda") : t("Ajuda")}
            </span>
            {aberto && (
              <>
                <ArrowSquareOut size={14} className="shrink-0" aria-hidden />
                <span className="sr-only">{t("(abre em nova aba)")}</span>
              </>
            )}
          </a>
        )}
        {nav.rodape && (
          <Link
            href={nav.rodape.href}
            {...intencao(nav.rodape.href)}
            title={aberto ? undefined : t(nav.rodape.label)}
            aria-current={nav.pathname.startsWith(nav.rodape.href) ? "page" : undefined}
            className={classeDoItem(aberto, nav.pathname.startsWith(nav.rodape.href))}
          >
            <Gear size={20} aria-hidden />
            <span className={cn("max-w-full truncate", aberto && "flex-1")}>
              {aberto ? t(nav.rodape.label) : t("Ajustes")}
            </span>
          </Link>
        )}
        <VersionFooter collapsed={collapsed} />
        <div aria-hidden className="mx-1.5 my-2 h-px bg-border" />
        <MenuDoUsuarioNovo aberto={aberto} />
        <button
          type="button"
          onClick={() => startTransition(() => toggleSidebar(collapsed))}
          disabled={recolhendo}
          aria-label={rotuloAlternar}
          title={rotuloAlternar}
          className={classeDoItem(aberto, false)}
        >
          {aberto ? <CaretDoubleLeft size={18} aria-hidden /> : <CaretDoubleRight size={18} aria-hidden />}
          {aberto && <span className="flex-1 text-left">{rotuloAlternar}</span>}
        </button>
      </div>
    </aside>
  );
}
