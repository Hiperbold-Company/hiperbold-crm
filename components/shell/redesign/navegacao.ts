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
  /** O nome para a faixa do celular: o da tela atual; em Configurações sem porta própria, "Configurações". */
  titulo: string | undefined;
  /** As abas da área: destinos visíveis do mesmo grupo e da mesma seção. */
  abasDaArea: NavDestination[];
  pathname: string;
}

/** `/app/inbox` vale para `/app/inbox/123`, mas não para `/app/inboxes`. */
export function estaEm(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Telas que o catálogo não lista com o próprio caminho, mas que pertencem a um
 * destino dele: o quadro de um funil (`/app/pipelines/<id>`) é o Pipeline.
 * Sem isto a moldura não acha a tela atual e, no celular, a faixa fica sem nome.
 */
const CAMINHOS_DE_OUTRO_DESTINO: ReadonlyArray<readonly [string, string]> = [
  ["/app/pipelines", "/app/kanban"],
];

export function caminhoNoCatalogo(pathname: string): string {
  for (const [de, para] of CAMINHOS_DE_OUTRO_DESTINO) {
    if (estaEm(pathname, de)) return para;
  }
  return pathname;
}

/**
 * A aba da tela atual: a de caminho mais longo que contém a tela. Sem a
 * escolha, "/app/tasks/planos" acendia "Tarefas" e "Planos de tarefa" juntas.
 */
export function abaDaTela(pathname: string, hrefs: readonly string[]): string | null {
  const caminho = caminhoNoCatalogo(pathname);
  let melhor: string | null = null;
  for (const href of hrefs) {
    if (estaEm(caminho, href) && (!melhor || href.length > melhor.length)) melhor = href;
  }
  return melhor;
}

/**
 * O hub (`/app/settings`) e as telas de Configurações que o catálogo não lista
 * (billing, templates, canal-oficial, atualizacao) não têm destino próprio:
 * `atual` fica vazio e a faixa do celular ficava sem nome. Nelas o nome é o do
 * hub. Pura — só olha o caminho e o `atual` já calculado.
 */
export function tituloDaTela(
  pathname: string,
  atual: Pick<NavDestination, "label"> | undefined,
): string | undefined {
  if (atual) return atual.label;
  const hub = NAV_GROUPS.find((g) => g.id === GRUPO_NO_RODAPE)?.hub;
  return hub && estaEm(pathname, hub.href) ? hub.label : undefined;
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

  const caminho = caminhoNoCatalogo(pathname);
  const atual = visiveis
    .filter((d) => estaEm(caminho, d.href))
    .sort((a, b) => b.href.length - a.href.length)[0];

  const titulo = tituloDaTela(pathname, atual);

  const abasDaArea = atual
    ? visiveis.filter((d) => d.group === atual.group && (d.section ?? "") === (atual.section ?? ""))
    : [];

  return { itens, rodape, todas, atual, titulo, abasDaArea, pathname };
}
