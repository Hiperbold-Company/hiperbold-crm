/**
 * DESEMPENHO (BI) — o filtro global e as contas pequenas que a tela e as rotas
 * dividem.
 *
 * As agregações moram no banco (`fn_desempenho_negocios`, `fn_desempenho_origens`,
 * `fn_desempenho_atendimento`, migrations 0981 e 0982), testadas em
 * `tests/invariants/desempenho-bi.test.ts`. Aqui fica só o que precisa ser igual
 * dos dois lados do fio: o formato do filtro na URL, a janela que cada atalho de
 * período representa e o teto de tamanho da janela.
 */
import { z } from "zod";

/** Janela padrão quando a URL não diz nada: os últimos 30 dias, como a tela sempre mostrou. */
export const DIAS_PADRAO = 30;
/** Teto da janela. Série diária de mais de um ano deixa de ser leitura e vira exportação. */
export const DIAS_MAXIMOS = 366;
const DIA_MS = 24 * 60 * 60 * 1000;

export const ABAS = ["negocios", "origens", "atendimento", "atrito"] as const;
export type Aba = (typeof ABAS)[number];

export const ATALHOS = ["hoje", "7d", "30d", "90d", "mes", "mes_anterior", "personalizado"] as const;
export type Atalho = (typeof ATALHOS)[number];

/** O que a rota aceita na query. Organização NUNCA vem daqui: vem da sessão. */
export const filtroDaQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  pipeline_id: z.string().uuid().optional(),
  owner_user_id: z.string().uuid().optional(),
});
export type FiltroDaQuery = z.infer<typeof filtroDaQuery>;

export type Janela = { ok: true; from: Date; to: Date } | { ok: false; motivo: "ordem" | "longa" };

/** Resolve a janela pedida: padrão de 30 dias até agora; recusa invertida e longa demais. */
export function resolverJanela(f: Pick<FiltroDaQuery, "from" | "to">, agora: Date = new Date()): Janela {
  const to = f.to ? new Date(f.to) : agora;
  const from = f.from ? new Date(f.from) : new Date(to.getTime() - DIAS_PADRAO * DIA_MS);
  if (from.getTime() >= to.getTime()) return { ok: false, motivo: "ordem" };
  if (to.getTime() - from.getTime() > DIAS_MAXIMOS * DIA_MS) return { ok: false, motivo: "longa" };
  return { ok: true, from, to };
}

function inicioDoDia(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * A janela de cada atalho, no relógio de quem olha (o navegador). Sempre
 * semiaberta e terminando no fim do dia de hoje, para que "hoje" inclua a
 * próxima hora sem recarregar.
 */
export function janelaDoAtalho(atalho: Exclude<Atalho, "personalizado">, agora: Date = new Date()): { from: Date; to: Date } {
  const amanha = new Date(inicioDoDia(agora).getTime());
  amanha.setDate(amanha.getDate() + 1);
  const voltar = (dias: number) => {
    const d = new Date(amanha.getTime());
    d.setDate(d.getDate() - dias);
    return d;
  };
  switch (atalho) {
    case "hoje":
      return { from: voltar(1), to: amanha };
    case "7d":
      return { from: voltar(7), to: amanha };
    case "30d":
      return { from: voltar(30), to: amanha };
    case "90d":
      return { from: voltar(90), to: amanha };
    case "mes":
      return { from: new Date(agora.getFullYear(), agora.getMonth(), 1), to: amanha };
    case "mes_anterior":
      return {
        from: new Date(agora.getFullYear(), agora.getMonth() - 1, 1),
        to: new Date(agora.getFullYear(), agora.getMonth(), 1),
      };
  }
}

/** `AAAA-MM-DD` de uma data local — o valor de um `<input type="date">`. */
export function paraDiaLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** O inverso: meia-noite local do dia. `null` para texto que não é data. */
export function deDiaLocal(s: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) || paraDiaLocal(d) !== s ? null : d;
}

export interface FiltrosDaTela {
  aba: Aba;
  atalho: Atalho;
  /** Só no atalho personalizado: dias locais, `ate` inclusivo. */
  de: string | null;
  ate: string | null;
  funil: string | null;
  atendente: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lê o filtro da URL. Valor estranho volta para o padrão em vez de quebrar a tela. */
export function lerFiltrosDaUrl(sp: { get(nome: string): string | null }): FiltrosDaTela {
  const aba = (ABAS as readonly string[]).includes(sp.get("aba") ?? "") ? (sp.get("aba") as Aba) : "negocios";
  let atalho = (ATALHOS as readonly string[]).includes(sp.get("periodo") ?? "")
    ? (sp.get("periodo") as Atalho)
    : "30d";
  const de = deDiaLocal(sp.get("de")) ? sp.get("de") : null;
  const ate = deDiaLocal(sp.get("ate")) ? sp.get("ate") : null;
  if (atalho === "personalizado" && (!de || !ate || de > ate)) atalho = "30d";
  const funil = UUID.test(sp.get("funil") ?? "") ? sp.get("funil") : null;
  const atendente = UUID.test(sp.get("atendente") ?? "") ? sp.get("atendente") : null;
  return {
    aba,
    atalho,
    de: atalho === "personalizado" ? de : null,
    ate: atalho === "personalizado" ? ate : null,
    funil,
    atendente,
  };
}

/** O filtro como query string da tela; o padrão não é escrito, para a URL ficar curta. */
export function filtrosParaUrl(f: FiltrosDaTela): string {
  const p = new URLSearchParams();
  if (f.aba !== "negocios") p.set("aba", f.aba);
  if (f.atalho !== "30d") p.set("periodo", f.atalho);
  if (f.atalho === "personalizado" && f.de && f.ate) {
    p.set("de", f.de);
    p.set("ate", f.ate);
  }
  if (f.funil) p.set("funil", f.funil);
  if (f.atendente) p.set("atendente", f.atendente);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** A janela [from, to) que o filtro da tela representa. */
export function janelaDosFiltros(f: FiltrosDaTela, agora: Date = new Date()): { from: Date; to: Date } {
  if (f.atalho === "personalizado") {
    const de = deDiaLocal(f.de);
    const ate = deDiaLocal(f.ate);
    if (de && ate && de.getTime() <= ate.getTime()) {
      const fim = new Date(ate.getTime());
      fim.setDate(fim.getDate() + 1);
      return { from: de, to: fim };
    }
    return janelaDoAtalho("30d", agora);
  }
  return janelaDoAtalho(f.atalho, agora);
}

/** Query string das rotas de métricas para o filtro da tela. */
export function queryDaApi(f: FiltrosDaTela, agora: Date = new Date()): string {
  const { from, to } = janelaDosFiltros(f, agora);
  const p = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (f.funil) p.set("pipeline_id", f.funil);
  if (f.atendente) p.set("owner_user_id", f.atendente);
  return p.toString();
}

/** Variação em % contra o período anterior. `null` quando não há base (anterior zero). */
export function variacaoPercentual(atual: number, anterior: number): number | null {
  if (anterior <= 0) return null;
  return Math.round(((atual - anterior) / anterior) * 1000) / 10;
}

/** Duração legível: 45s, 3min, 2h 5min, 1d 4h. `—` para ausência. */
export function formatarDuracao(segundos: number | null | undefined): string {
  if (segundos == null || !Number.isFinite(segundos)) return "—";
  const s = Math.max(0, Math.round(segundos));
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** Tipos das listas da tabela de negócios. */
export const TIPOS_DA_LISTA = ["criados", "ganhos", "perdidos", "em_aberto", "carteira"] as const;
export type TipoDaLista = (typeof TIPOS_DA_LISTA)[number];

/** Posição da etapa no funil, de 0 a 1, para a barra de progresso. `null` sem etapa conhecida. */
export function progressoNaEtapa(stageId: string, etapasDoFunil: string[]): number | null {
  const i = etapasDoFunil.indexOf(stageId);
  if (i < 0 || etapasDoFunil.length === 0) return null;
  return (i + 1) / etapasDoFunil.length;
}

/** Dias inteiros entre dois instantes (nunca negativo). */
export function diasEntre(inicio: Date, fim: Date): number {
  return Math.max(0, Math.floor((fim.getTime() - inicio.getTime()) / DIA_MS));
}
