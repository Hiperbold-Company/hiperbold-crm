/**
 * A LISTA ÚNICA de /app/automacoes (lote 5): automações novas, follow-ups e
 * regras antigas num lugar só. Função pura — a página lê as três fontes (sempre
 * filtrando a organização) e esta função junta, tira a regra que já virou
 * automação e diz para onde cada linha abre.
 *
 * Para onde abre:
 *   • automação → o editor (`/app/automacoes/<id>`);
 *   • follow-up → o editor de follow-up, que continua em `/app/ai/followups`;
 *   • regra antiga conversível → a pré-visualização da conversão;
 *   • regra antiga sem equivalente → a tela antiga (`/app/webhooks?tab=rules`),
 *     onde ela continua sendo editada e continua rodando.
 */

export const TIPOS_DA_LISTA = ["automacao", "followup", "regra"] as const;
export type TipoDaLista = (typeof TIPOS_DA_LISTA)[number];

/** O tipo em palavra simples, como a tela mostra. */
export const ROTULO_DO_TIPO: Record<TipoDaLista, string> = {
  automacao: "Automação",
  followup: "Follow-up",
  regra: "Regra antiga",
};

export interface PonteiroDaLista {
  id: string;
  name: string;
  status: string;
  surface: string | null;
  updated_at: string;
}

export interface RegraDaLista {
  id: string;
  name: string;
  is_active: boolean;
  last_run_at: string | null;
  updated_at: string;
  migrated_to_pointer_id: string | null;
  /** Calculado no servidor por `converterRegra`. */
  conversivel: boolean;
}

export interface LinhaDaLista {
  id: string;
  nome: string;
  tipo: TipoDaLista;
  ligado: boolean;
  /** `status` do ponteiro (draft/active/disabled); regra: active/disabled. */
  status: string;
  ultimaExecucao: string | null;
  atualizadoEm: string;
  href: string;
  /** Só regra antiga: tem equivalente no motor novo? */
  conversivel?: boolean;
}

export function montarListaUnica(entrada: {
  automacoes: PonteiroDaLista[];
  followups: PonteiroDaLista[];
  regras: RegraDaLista[];
  /** pointer_id → início da execução mais recente. */
  ultimasExecucoes: Record<string, string>;
}): LinhaDaLista[] {
  const linhas: LinhaDaLista[] = [];
  for (const a of entrada.automacoes) {
    if (a.surface !== "automacao") continue;
    linhas.push({
      id: a.id,
      nome: a.name,
      tipo: "automacao",
      ligado: a.status === "active",
      status: a.status,
      ultimaExecucao: entrada.ultimasExecucoes[a.id] ?? null,
      atualizadoEm: a.updated_at,
      href: `/app/automacoes/${a.id}`,
    });
  }
  for (const f of entrada.followups) {
    // Roteiro de atendimento e automação têm tela própria; nunca entram como follow-up.
    if (f.surface === "atendimento" || f.surface === "automacao") continue;
    linhas.push({
      id: f.id,
      nome: f.name,
      tipo: "followup",
      ligado: f.status === "active",
      status: f.status,
      ultimaExecucao: entrada.ultimasExecucoes[f.id] ?? null,
      atualizadoEm: f.updated_at,
      href: `/app/ai/followups/${f.id}`,
    });
  }
  for (const r of entrada.regras) {
    // Já virou automação: aparece uma vez só, como automação.
    if (r.migrated_to_pointer_id) continue;
    linhas.push({
      id: r.id,
      nome: r.name,
      tipo: "regra",
      ligado: r.is_active,
      status: r.is_active ? "active" : "disabled",
      ultimaExecucao: r.last_run_at,
      atualizadoEm: r.updated_at,
      href: r.conversivel ? `/app/automacoes/converter/${r.id}` : `/app/webhooks?tab=rules&regra=${r.id}`,
      conversivel: r.conversivel,
    });
  }
  return linhas.sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : a.atualizadoEm > b.atualizadoEm ? -1 : 0));
}

/** Filtro por tipo e busca por nome (sem acento, sem maiúsculas). */
export function filtrarLista(linhas: LinhaDaLista[], tipo: TipoDaLista | "todos", busca: string): LinhaDaLista[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const alvo = norm(busca);
  return linhas.filter((l) => (tipo === "todos" || l.tipo === tipo) && (alvo === "" || norm(l.nome).includes(alvo)));
}

/** A execução mais recente por ponteiro, a partir das linhas já ordenadas por `started_at desc`. */
export function ultimaExecucaoPorPonteiro(execucoes: { pointer_id: string; started_at: string | null }[]): Record<string, string> {
  const mapa: Record<string, string> = {};
  for (const e of execucoes) {
    if (!e.started_at) continue;
    const atual = mapa[e.pointer_id];
    if (!atual || e.started_at > atual) mapa[e.pointer_id] = e.started_at;
  }
  return mapa;
}
