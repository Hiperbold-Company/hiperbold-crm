"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { useEscolherIdioma } from "@/components/shell/SeletorDeIdioma";
import { abrirModoAdministrador, navegarPeloItemDoMenu } from "@/components/shell/UserMenu";
import { useCicloDoTema } from "@/components/theme/theme-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth, useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoPapel } from "@/lib/auth/types";
import { IDIOMAS_VISIVEIS } from "@/lib/i18n/registro";
import type { Theme } from "@/lib/theme";
import { Check, Globe, MonitorPlay, Moon, ShieldCheck, SignOut, Sun, UserCircle } from "@/lib/ui/icons";
import { iniciaisDoNome } from "@/lib/ui/iniciais";
import { cn } from "@/lib/utils";

/** O rótulo de cada tema, na ordem do protótipo. */
export const TEMAS: ReadonlyArray<{ valor: Theme; rotulo: string }> = [
  { valor: "light", rotulo: "Claro" },
  { valor: "dark", rotulo: "Escuro" },
  { valor: "system", rotulo: "Igual ao sistema" },
];

/**
 * O menu "Sua conta" da moldura nova: perfil, tema, idioma, modo administrador
 * e sair, no pé do menu lateral.
 *
 * Nenhum mecanismo é reescrito aqui. Idioma é `useEscolherIdioma` (o mesmo do
 * `SeletorDeIdioma`, com a recarga), tema é `useCicloDoTema` (que também
 * mantém o atalho `mod+shift+l` vivo com o menu fechado), a porta do admin é
 * `abrirModoAdministrador` e sair é o `signOut` do `AuthProvider`.
 */
export function MenuDoUsuarioNovo({ aberto }: { aberto: boolean }) {
  const t = useT();
  const user = useUser();
  const { signOut, activeOrg } = useAuth();
  const router = useRouter();
  const [saindo, startTransition] = useTransition();
  const { theme, setTheme } = useCicloDoTema();
  const { idioma, emVigor, escolher, salvando } = useEscolherIdioma();
  const iniciais = iniciaisDoNome(user.full_name) ?? user.email.slice(0, 2).toUpperCase();
  const nome = user.full_name ?? user.email;
  const papel = activeOrg?.role ? t(rotuloDoPapel(activeOrg.role)) : "";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="menu-do-usuario"
          aria-label={`${t("Sua conta")}: ${iniciais}`}
          title={nome}
          className={cn(
            "flex w-full items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            aberto ? "gap-3 px-3 py-2 text-left" : "justify-center py-2",
          )}
        >
          <Avatar className="h-8 w-8 shrink-0">
            {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
            <AvatarFallback className="bg-accent text-xs font-bold text-accent-foreground">
              {iniciais}
            </AvatarFallback>
          </Avatar>
          {aberto && (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold text-foreground">{nome}</span>
              {papel && <span className="truncate text-xs">{papel}</span>}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-64 p-1.5">
        <DropdownMenuLabel className="pb-2">
          <span className="flex flex-col">
            <span className="text-sm font-semibold">{nome}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {[papel, activeOrg?.name].filter(Boolean).join(" · ") || user.email}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {user.is_platform_admin && (
          <>
            <DropdownMenuItem asChild onClick={(event) => abrirModoAdministrador(event, router)}>
              <Link href="/admin" data-testid="porta-modo-administrador">
                <ShieldCheck size={16} aria-hidden />
                <span className="flex flex-col">
                  <span>{t("Modo administrador")}</span>
                  <span className="text-xs text-muted-foreground">{t("Configurar este servidor")}</span>
                </span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          asChild
          onClick={(event) => navegarPeloItemDoMenu(event, router, "/app/settings/profile")}
        >
          <Link href="/app/settings/profile">
            <UserCircle size={16} aria-hidden />
            {t("Meu perfil")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="seletor-tema">
            {theme === "dark" ? <Moon aria-hidden /> : theme === "system" ? <MonitorPlay aria-hidden /> : <Sun aria-hidden />}
            <span className="flex-1">{t("Tema")}</span>
            <span className="text-xs text-muted-foreground" suppressHydrationWarning>
              {t(TEMAS.find((x) => x.valor === theme)?.rotulo ?? "Claro")}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[180px]">
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              {TEMAS.map((tema) => (
                <DropdownMenuRadioItem key={tema.valor} value={tema.valor}>
                  {t(tema.rotulo)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            data-testid="seletor-de-idioma"
            disabled={salvando}
            aria-label={`${t("Idioma")}: ${emVigor.rotuloCurto} — ${emVigor.nomeNativo}`}
          >
            <Globe aria-hidden />
            <span className="flex-1">{t("Idioma")}</span>
            <span className="text-xs text-muted-foreground">{emVigor.nomeNativo}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[180px]">
            {IDIOMAS_VISIVEIS.map(({ codigo, nomeNativo }) => (
              <DropdownMenuItem
                key={codigo}
                onClick={() => escolher(codigo)}
                data-testid={`idioma-${codigo}`}
                aria-current={codigo === idioma}
              >
                <Check size={16} className={codigo === idioma ? "" : "invisible"} aria-hidden />
                {nomeNativo}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={saindo}
          onClick={() =>
            startTransition(async () => {
              await signOut();
            })
          }
        >
          <SignOut size={16} aria-hidden />
          {t("Sair")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
