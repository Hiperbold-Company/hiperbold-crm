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

/** Um grupo de uma coluna lateral (IA: Montar/Ensinar/Acompanhar; Configurações: Você/Empresa/Integrações). */
export interface GrupoDaColuna {
  rotulo: string;
  abas: readonly string[];
}
export type GrupoDaIA = GrupoDaColuna;

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
  return agruparNaColuna(GRUPOS_DA_IA, visiveis);
}

/**
 * Os destinos de uma coluna lateral, por grupo e na ordem declarada. Grupo
 * vazio some. Com `restoNoUltimo`, destino recebido que nenhum grupo declara
 * entra no fim do ÚLTIMO grupo, na ordem em que chegou — porta nova do
 * catálogo nunca fica sem lugar na coluna.
 */
export function agruparNaColuna<T extends ComHref>(
  grupos: readonly GrupoDaColuna[],
  visiveis: ReadonlyArray<T>,
  { restoNoUltimo = false }: { restoNoUltimo?: boolean } = {},
): Array<{ rotulo: string; itens: T[] }> {
  const saida = grupos.map((g) => ({ rotulo: g.rotulo, itens: visiveisNaOrdem(g.abas, visiveis) }));
  const ultimo = saida[saida.length - 1];
  if (restoNoUltimo && ultimo) {
    const declarados = new Set(grupos.flatMap((g) => g.abas));
    ultimo.itens.push(...visiveis.filter((d) => !declarados.has(d.href)));
  }
  return saida.filter((g) => g.itens.length > 0);
}

/**
 * A COLUNA DE CONFIGURAÇÕES (v49): Você / Empresa / Integrações.
 *
 * Só organiza: a lista é dos hrefs do grupo de Configurações do catálogo, e o
 * que entra é o que o chamador já filtrou pelo papel. A cerca de
 * `tests/unit/redesign-onda5-configuracoes.test.tsx` cobra que todo href daqui
 * existe no catálogo.
 */
export const GRUPOS_DAS_CONFIGURACOES: readonly GrupoDaColuna[] = [
  {
    rotulo: "Você",
    abas: [
      "/app/settings/profile",
      "/app/settings/security",
      "/app/settings/notifications",
      "/app/settings/aplicativo",
      "/app/ajuda",
    ],
  },
  {
    rotulo: "Empresa",
    abas: [
      "/app/settings/tenant",
      "/app/team",
      "/app/settings/atendimento",
      "/app/settings/marca",
      "/app/settings/metas",
      "/app/settings/tags",
      "/app/settings/plano",
      "/app/lgpd/requests",
      "/app/settings/recursos",
      "/app/settings/tenant/proposals/modelos",
      "/app/settings/tenant/proposals",
      "/app/settings/tenant/financeiro",
      "/app/settings/campos-personalizados",
      "/app/settings/motivos-de-perda",
      "/app/settings/automacoes",
    ],
  },
  {
    rotulo: "Integrações",
    abas: [
      "/app/settings/conversoes",
      "/app/settings/meta-ads",
      "/app/settings/api-tokens",
      "/app/ai/credentials",
      "/app/settings/voip-trunk",
      "/app/settings/servidor-mcp-externo",
      "/app/extensions",
      "/app/integracao-dados",
    ],
  },
];

/**
 * Os grupos da coluna de Configurações a partir dos destinos visíveis DO
 * GRUPO de Configurações. O destino que já é aba de uma área do v49 (Tipos e
 * Aviso de agendamento são da Agenda) fica na área dele: na coluna, o clique
 * levaria a outra área e a coluna sumiria debaixo do dedo.
 */
export function gruposDasConfiguracoes<T extends ComHref>(
  daConfiguracao: ReadonlyArray<T>,
): Array<{ rotulo: string; itens: T[] }> {
  const deArea = new Set(AREAS_DO_V49.flatMap((a) => a.abas));
  return agruparNaColuna(
    GRUPOS_DAS_CONFIGURACOES,
    daConfiguracao.filter((d) => !deArea.has(d.href)),
    { restoNoUltimo: true },
  );
}
