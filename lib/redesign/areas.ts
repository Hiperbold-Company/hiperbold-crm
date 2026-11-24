/**
 * AS ÁREAS DO PROTÓTIPO V49 — o menu da moldura nova.
 *
 * Puro, sem React. Não decide permissão: recebe os destinos que o catálogo já
 * deixou o papel ver e só os ORGANIZA em áreas, faixa de abas e coluna da IA.
 * Destino que o papel não vê nunca aparece. Cada função devolve os próprios
 * objetos recebidos (o casco precisa do rótulo e do ícone deles).
 */

/** `/app/inbox` vale para `/app/inbox/123`, mas não para `/app/inboxes`. */
export function estaEm(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Telas que o catálogo não lista com o próprio caminho, mas que pertencem a um
 * destino dele: o quadro de um funil (`/app/pipelines/<id>`) é o Pipeline.
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

export type IdDeArea =
  | "inicio"
  | "conversas"
  | "pipeline"
  | "contatos"
  | "tarefas"
  | "agenda"
  | "metricas"
  | "ia"
  | "automacoes"
  | "conexoes";

export interface GrupoDaIA {
  rotulo: string;
  abas: readonly string[];
}

export interface AreaV49 {
  id: IdDeArea;
  rotulo: string;
  /** Hrefs do catálogo, na ordem do v49. */
  abas: readonly string[];
  /** Só a IA: Montar / Ensinar / Acompanhar (as abas são a concatenação). */
  grupos?: readonly GrupoDaIA[];
  /** Fora do menu lateral (no v49 mora no "Mais"). */
  foraDoMenu?: boolean;
}

const GRUPOS_DA_IA: readonly GrupoDaIA[] = [
  {
    rotulo: "Montar",
    abas: [
      "/app/ai/agents",
      "/app/ai/followups",
      "/app/ai/routers",
      "/app/ai/jev",
      "/app/ai/providers",
      "/app/ai/atendimento",
    ],
  },
  {
    rotulo: "Ensinar",
    abas: ["/app/ai/knowledge/sources", "/app/ai/memory", "/app/ai/skills", "/app/ai/mcp"],
  },
  {
    rotulo: "Acompanhar",
    abas: [
      "/app/ai/cases",
      "/app/ai/inbox",
      "/app/ai/cases/avisos",
      "/app/ai/proposals",
      "/app/ai/runs",
      "/app/ai/usage",
    ],
  },
];

export const AREAS_DO_V49: readonly AreaV49[] = [
  { id: "inicio", rotulo: "Início", abas: ["/app/inicio"] },
  { id: "conversas", rotulo: "Conversas", abas: ["/app/inbox", "/app/radar", "/app/templates"] },
  {
    id: "pipeline",
    rotulo: "Pipeline",
    abas: ["/app/kanban", "/app/settings/tenant/pipelines", "/app/products", "/app/proposals"],
  },
  {
    id: "contatos",
    rotulo: "Contatos",
    abas: ["/app/contacts", "/app/campaigns", "/app/imports", "/app/companies", "/app/people"],
  },
  {
    id: "tarefas",
    rotulo: "Tarefas",
    abas: ["/app/tasks", "/app/tasks/planos", "/app/calls", "/app/prospecting", "/app/cold-call"],
  },
  {
    id: "agenda",
    rotulo: "Agenda",
    abas: ["/app/agenda", "/app/settings/tenant/agenda", "/app/agenda/avisos"],
  },
  {
    id: "metricas",
    rotulo: "Métricas",
    abas: [
      "/app/metrics",
      "/app/activities",
      "/app/faturamento",
      "/app/ai/evolution",
      "/app/audit",
      "/app/ads/meta",
      "/app/comandas",
      "/app/honorarios",
    ],
  },
  { id: "ia", rotulo: "IA", abas: GRUPOS_DA_IA.flatMap((g) => g.abas), grupos: GRUPOS_DA_IA },
  { id: "automacoes", rotulo: "Automações", abas: ["/app/automacoes"] },
  {
    id: "conexoes",
    rotulo: "Conexões",
    abas: ["/app/connections", "/app/integrations/nuvemshop", "/app/webhooks"],
    foraDoMenu: true,
  },
];

type ComHref = { href: string };

/** Os destinos visíveis da lista de hrefs, na ordem dela. */
function visiveisNaOrdem<T extends ComHref>(hrefs: readonly string[], visiveis: ReadonlyArray<T>): T[] {
  const porHref = new Map(visiveis.map((d) => [d.href, d] as const));
  return hrefs.flatMap((h) => {
    const d = porHref.get(h);
    return d ? [d] : [];
  });
}

export function abasDaAreaV49<T extends ComHref>(area: AreaV49, visiveis: ReadonlyArray<T>): T[] {
  return visiveisNaOrdem(area.abas, visiveis);
}

export interface AreaDoMenu<T extends ComHref> {
  id: IdDeArea;
  rotulo: string;
  /** A primeira aba que o papel vê. */
  href: string;
  /** O destino dessa primeira aba (ícone e rótulo do catálogo). */
  primeira: T;
}

export function areasDoMenu<T extends ComHref>(visiveis: ReadonlyArray<T>): Array<AreaDoMenu<T>> {
  return AREAS_DO_V49.filter((a) => !a.foraDoMenu).flatMap((a) => {
    const primeira = abasDaAreaV49(a, visiveis)[0];
    return primeira ? [{ id: a.id, rotulo: a.rotulo, href: primeira.href, primeira }] : [];
  });
}

/** A área da tela: a que tem a aba visível de caminho MAIS LONGO contendo a tela. */
export function areaDaTela<T extends ComHref>(pathname: string, visiveis: ReadonlyArray<T>): AreaV49 | null {
  const caminho = caminhoNoCatalogo(pathname);
  let melhor: { area: AreaV49; tamanho: number } | null = null;
  for (const area of AREAS_DO_V49) {
    for (const aba of abasDaAreaV49(area, visiveis)) {
      if (estaEm(caminho, aba.href) && (!melhor || aba.href.length > melhor.tamanho)) {
        melhor = { area, tamanho: aba.href.length };
      }
    }
  }
  return melhor?.area ?? null;
}

export function gruposDaIA<T extends ComHref>(
  visiveis: ReadonlyArray<T>,
): Array<{ rotulo: string; itens: T[] }> {
  return GRUPOS_DA_IA.map((g) => ({ rotulo: g.rotulo, itens: visiveisNaOrdem(g.abas, visiveis) })).filter(
    (g) => g.itens.length > 0,
  );
}
