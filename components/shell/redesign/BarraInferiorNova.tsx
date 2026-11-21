"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { PREFERIDAS, VAGAS } from "@/components/shell/BarraInferior";
import { ContadorDaFila } from "@/components/shell/ContadorDaFila";
import { ContadorDeCasos } from "@/components/shell/ContadorDeCasos";
import { useEscolherIdioma } from "@/components/shell/SeletorDeIdioma";
import { abrirModoAdministrador } from "@/components/shell/UserMenu";
import { useCicloDoTema } from "@/components/theme/theme-toggle";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAuth, useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";
import { CAMINHO_PADRAO_DA_AJUDA, urlNaCentral } from "@/lib/ajuda/artigos";
import { useBaseDaCentralDeAjuda } from "@/lib/ajuda/contexto";
import { IDIOMAS_VISIVEIS } from "@/lib/i18n/registro";
import type { NavDestination } from "@/lib/navigation/registry";
import { usePecaDoRodape, type PecaDoRodape } from "@/lib/ui/rodape-ocupado";
import { DotsThree, Question, ShieldCheck, SignOut } from "@/lib/ui/icons";
import { iniciaisDoNome } from "@/lib/ui/iniciais";
import { cn } from "@/lib/utils";

import { CartaoDaEmpresa } from "./MarcaECartaoDaEmpresa";
import { TEMAS } from "./MenuDoUsuarioNovo";
import { caminhoNoCatalogo, estaEm, useNavegacaoDaMoldura } from "./navegacao";
import { TodasAsSecoes } from "./TodasAsSecoes";

/**
 * O que a barra ocupa no rodapé — o MESMO contrato da `BarraInferior` de
 * sempre, e pelo mesmo motivo `altura: 0`: ela está no DOM com `md:hidden`
 * acima de 768px, e só a medição sabe quando ela aparece (ver o comentário de
 * `BARRA_INFERIOR` em `components/shell/BarraInferior.tsx`).
 */
export const BARRA_INFERIOR_NOVA: PecaDoRodape = {
  dono: "components/shell/redesign/BarraInferiorNova.tsx",
  distancia: 0,
  altura: 0,
};

/**
 * A barra de abas do celular na moldura nova (protótipo `MaisCelular`).
 *
 * As abas saem da MESMA régua da barra de sempre: `PREFERIDAS` e `VAGAS` de
 * `BarraInferior.tsx`, filtradas pelo que `sidebarGroups()` deixa este papel
 * ver. A última vaga é o "Mais", que abre o inventário inteiro e a conta — e
 * ele existe SEMPRE: sem abas (papel `viewer` com quase tudo desligado), a
 * barra fica só com ele, porque é a única porta para a conta e para sair.
 */
export function BarraInferiorNova() {
  const t = useT();
  const intencao = usePrefetchPorIntencao();
  const nav = useNavegacaoDaMoldura();
  const ancora = usePecaDoRodape(BARRA_INFERIOR_NOVA);

  const visiveis = new Map<string, NavDestination>(nav.itens.map((d) => [d.href, d]));
  const abas = PREFERIDAS.map((href) => visiveis.get(href))
    .filter((d): d is NavDestination => d !== undefined)
    .slice(0, VAGAS);

  return (
    <nav
      ref={ancora}
      aria-label={t("Navegação rápida")}
      data-barra-inferior
      data-moldura="redesign"
      style={{ bottom: BARRA_INFERIOR_NOVA.distancia }}
      className="fixed inset-x-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom,0px)] md:hidden"
    >
      <ul className="flex items-stretch px-1 pt-1.5 pb-2">
        {abas.map((aba) => {
          const Icone = aba.icon;
          const aqui = estaEm(caminhoNoCatalogo(nav.pathname), aba.href);
          return (
            <li key={aba.href} className="flex min-w-0 flex-1">
              <Link
                href={aba.href}
                {...intencao(aba.href)}
                aria-current={aqui ? "page" : undefined}
                className={cn(
                  "flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-2xs",
                  aqui ? "font-bold text-accent" : "font-medium text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "relative inline-flex h-7.5 w-14 items-center justify-center rounded-full transition-colors duration-base",
                    aqui && "bg-accent-soft",
                  )}
                >
                  <Icone size={22} weight={aqui ? "fill" : "regular"} aria-hidden />
                  {aba.contador === "fila" && <ContadorDaFila compacto />}
                  {aba.contador === "casos" && <ContadorDeCasos compacto />}
                </span>
                <span className="w-full truncate text-center leading-tight">{t(aba.label)}</span>
              </Link>
            </li>
          );
        })}
        <li className="flex min-w-0 flex-1">
          <PainelMaisCelular />
        </li>
      </ul>
    </nav>
  );
}

/**
 * O "Mais" do celular: a conta, o inventário inteiro, ajuda, empresa, tema,
 * idioma e sair — os mesmos mecanismos do menu do usuário da moldura nova.
 */
function PainelMaisCelular() {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const nav = useNavegacaoDaMoldura();
  const user = useUser();
  const { signOut, activeOrg } = useAuth();
  const router = useRouter();
  const [saindo, startTransition] = useTransition();
  // O atalho `mod+shift+l` já é registrado pelo menu do usuário do menu
  // lateral, sempre montado; registrá-lo aqui também o faria disparar duas vezes.
  const { theme, setTheme } = useCicloDoTema({ atalho: false });
  const { idioma, escolher, salvando } = useEscolherIdioma();
  const centralDeAjuda = urlNaCentral(useBaseDaCentralDeAjuda(), CAMINHO_PADRAO_DA_AJUDA);
  const iniciais = iniciaisDoNome(user.full_name) ?? user.email.slice(0, 2).toUpperCase();
  const fechar = () => setAberto(false);
  const linha =
    "flex min-h-13 w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left text-base text-foreground last:border-b-0";

  return (
    <Sheet open={aberto} onOpenChange={setAberto}>
      <SheetTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-2xs",
            aberto ? "font-bold text-accent" : "font-medium text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "inline-flex h-7.5 w-14 items-center justify-center rounded-full",
              aberto && "bg-accent-soft",
            )}
          >
            <DotsThree size={22} aria-hidden />
          </span>
          <span className="w-full truncate text-center leading-tight">{t("Mais")}</span>
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="flex h-[92dvh] flex-col gap-0 bg-bg p-0">
        <div className="flex h-14 shrink-0 items-center border-b border-border bg-surface px-4">
          <SheetTitle className="text-xl font-bold">{t("Mais")}</SheetTitle>
          <SheetDescription className="sr-only">
            {t("Sua conta, todas as seções, ajuda, tema e idioma.")}
          </SheetDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <Link
            href="/app/settings/profile"
            onClick={fechar}
            className="flex min-h-18 items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-2.5"
          >
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-base font-semibold text-accent-foreground">
              {iniciais}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-base font-semibold">{user.full_name ?? user.email}</span>
              <span className="truncate text-sm text-muted-foreground">
                {[t("Meu perfil"), activeOrg?.name].filter(Boolean).join(" · ")}
              </span>
            </span>
          </Link>

          <div className="flex min-h-80 flex-col overflow-hidden rounded-2xl border border-border bg-surface pt-3">
            <TodasAsSecoes todas={nav.todas} pathname={nav.pathname} onNavigate={fechar} />
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-surface">
            {centralDeAjuda && (
              <a href={centralDeAjuda} target="_blank" rel="noopener noreferrer" className={linha}>
                <Question size={22} className="text-muted-foreground" aria-hidden />
                <span className="flex-1">{t("Central de ajuda")}</span>
                <span className="sr-only">{t("(abre em nova aba)")}</span>
              </a>
            )}
            {user.is_platform_admin && (
              <Link
                href="/admin"
                data-testid="porta-modo-administrador"
                onClick={(event) => abrirModoAdministrador(event, router)}
                className={linha}
              >
                <ShieldCheck size={22} className="text-muted-foreground" aria-hidden />
                <span className="flex-1">{t("Modo administrador")}</span>
              </Link>
            )}
            {(user.organizations.length > 1 || user.is_platform_admin) && (
              <div className={linha}>
                <span className="flex-1">{t("Trocar de empresa")}</span>
                <span className="w-48 shrink-0">
                  <CartaoDaEmpresa aberto largura="celular" />
                </span>
              </div>
            )}
          </div>

          <section className="flex flex-col gap-2">
            <h3 className="block text-sm font-semibold text-muted-foreground">{t("Tema")}</h3>
            <div role="radiogroup" aria-label={t("Tema")} className="flex gap-1 rounded-xl bg-surface-elevated p-1">
              {TEMAS.map((tema) => (
                <button
                  key={tema.valor}
                  type="button"
                  role="radio"
                  aria-checked={theme === tema.valor}
                  onClick={() => setTheme(tema.valor)}
                  suppressHydrationWarning
                  className={cn(
                    "min-h-10 flex-1 rounded-lg text-sm",
                    theme === tema.valor ? "bg-surface font-semibold text-foreground shadow-sm" : "text-muted-foreground",
                  )}
                >
                  {t(tema.rotulo)}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 id="mais-idioma" className="block text-sm font-semibold text-muted-foreground">
              {t("Idioma")}
            </h3>
            <div
              role="group"
              aria-labelledby="mais-idioma"
              data-testid="seletor-de-idioma"
              className="flex flex-wrap gap-1 rounded-xl bg-surface-elevated p-1"
            >
              {IDIOMAS_VISIVEIS.map(({ codigo, nomeNativo }) => (
                <button
                  key={codigo}
                  type="button"
                  disabled={salvando}
                  onClick={() => escolher(codigo)}
                  data-testid={`idioma-${codigo}`}
                  aria-current={codigo === idioma}
                  className={cn(
                    "min-h-10 flex-1 rounded-lg px-3 text-sm",
                    codigo === idioma ? "bg-surface font-semibold text-foreground shadow-sm" : "text-muted-foreground",
                  )}
                >
                  {nomeNativo}
                </button>
              ))}
            </div>
          </section>

          <button
            type="button"
            disabled={saindo}
            onClick={() =>
              startTransition(async () => {
                await signOut();
              })
            }
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface text-base font-semibold text-error"
          >
            <SignOut size={18} aria-hidden />
            {t("Sair")}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
