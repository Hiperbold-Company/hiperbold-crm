"use client";
import { usePathname } from "next/navigation";

import { useAuth } from "@/hooks/auth/AuthProvider";
import {
  GRUPO_NO_RODAPE,
  NAV_GROUPS,
  searchable,
  sidebarGroups,
  type NavDestination,
  type NavGroup,
} from "@/lib/navigation/registry";

/**
 * A NAVEGAÇÃO DA MOLDURA NOVA — projeção, não régua.
 *
 * Tudo sai das MESMAS funções que a moldura de sempre usa (`sidebarGroups` e
 * `searchable`, em `lib/navigation/registry.ts`), com os MESMOS argumentos.
 * Nada aqui decide permissão: uma porta que o menu antigo não mostraria não
 * aparece no novo, e não existe segunda lista para divergir do catálogo.
 */
export interface NavegacaoDaMoldura {
  /** As portas do menu lateral, na ordem do catálogo, sem o grupo do rodapé. */
  itens: NavDestination[];
  /** O destino do rodapé (Configurações), quando o papel o vê. */
  rodape: NavGroup["hub"] | undefined;
  /** Inventário completo ("Mais"): todo destino visível, por grupo, com o hub. */
  todas: Array<{ group: NavGroup; items: NavDestination[] }>;
  /** O destino em que a pessoa está, pelo prefixo mais longo. */
  atual: NavDestination | undefined;
  /** As abas da área: destinos visíveis do mesmo grupo e da mesma seção. */
  abasDaArea: NavDestination[];
  pathname: string;
}

/** `/app/inbox` vale para `/app/inbox/123`, mas não para `/app/inboxes`. */
export function estaEm(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function useNavegacaoDaMoldura(): NavegacaoDaMoldura {
  const pathname = usePathname() ?? "";
  const { user, activeOrg } = useAuth();
  const args = [
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
    activeOrg?.modulos_ligados ?? [],
    activeOrg?.capacidades_ligadas ?? [],
  ] as const;

  const grupos = sidebarGroups(...args);
  const itens = grupos.filter((g) => g.group.id !== GRUPO_NO_RODAPE).flatMap((g) => g.items);
  const rodape = grupos.find((g) => g.group.id === GRUPO_NO_RODAPE)?.group.hub;

  const visiveis = searchable(...args);
  const todas = NAV_GROUPS.map((group) => ({
    group,
    items: visiveis.filter((d) => d.group === group.id),
  })).filter((g) => g.items.length > 0);

  const atual = visiveis
    .filter((d) => estaEm(pathname, d.href))
    .sort((a, b) => b.href.length - a.href.length)[0];

  const abasDaArea = atual
    ? visiveis.filter((d) => d.group === atual.group && (d.section ?? "") === (atual.section ?? ""))
    : [];

  return { itens, rodape, todas, atual, abasDaArea, pathname };
}
